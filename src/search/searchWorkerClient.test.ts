// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { SearchWorkerClient, type SearchWorkerPort } from "./searchWorkerClient";
import { type SearchRequest, type SearchResponse, SearchWorkError, performSearchTask } from "./searchWork";

class ManualWorker implements SearchWorkerPort {
  onmessage: SearchWorkerPort["onmessage"] = null;
  onerror: SearchWorkerPort["onerror"] = null;
  onmessageerror: SearchWorkerPort["onmessageerror"] = null;
  requests: SearchRequest[] = [];
  terminate = vi.fn();
  postMessage(request: SearchRequest) { this.requests.push(request); }
  reply(response: SearchResponse) { this.onmessage?.(new MessageEvent("message", { data: response })); }
}
const task = { kind: "find" as const, text: "aaaa!", query: { text: "(a+)+$", caseSensitive: true, regexp: true } };
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it("시간이 끝나면 멈춘 정규식 작업자를 종료하고 다음 검색은 새 작업자로 시작한다", async () => {
  vi.useFakeTimers();
  const workers: ManualWorker[] = [];
  const client = new SearchWorkerClient(() => { const worker = new ManualWorker(); workers.push(worker); return worker; });
  const stalled = client.run(task).catch((error: SearchWorkError) => error);
  const oldMessage = workers[0].onmessage!;
  await vi.advanceTimersByTimeAsync(2000);
  expect(await stalled).toMatchObject({ code: "timeout" });
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  const next = client.run({ ...task, query: { ...task.query, text: "a" } });
  oldMessage(new MessageEvent("message", { data: { id: workers[0].requests[0].id, ok: true, result: { kind: "find", matches: [{ from: 0, to: 4 }] } } }));
  workers[1].reply({ id: workers[1].requests[0].id, ok: true, result: { kind: "find", matches: [{ from: 0, to: 1 }] } });
  expect(await next).toEqual({ kind: "find", matches: [{ from: 0, to: 1 }] });
  client.dispose();
});

it("새 요청은 이전 작업을 취소하고 완료한 작업자는 다음 요청에서 재사용한다", async () => {
  vi.useFakeTimers();
  const factory = vi.fn(() => new ManualWorker()), client = new SearchWorkerClient(factory);
  const first = client.run(task).catch((error: SearchWorkError) => error);
  const second = client.run(task);
  expect(await first).toMatchObject({ code: "cancelled" });
  expect(factory.mock.results[0].value.terminate).toHaveBeenCalledOnce();
  const worker = factory.mock.results[1].value;
  worker.reply({ id: worker.requests[0].id, ok: true, result: { kind: "find", matches: [] } });
  await second;
  const third = client.run(task);
  expect(factory).toHaveBeenCalledTimes(2);
  worker.reply({ id: worker.requests[1].id, ok: true, result: { kind: "find", matches: [] } });
  await third;
  client.dispose();
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("작업자를 만들지 못하면 동기 정규식 실행으로 우회하지 않는다", async () => {
  const client = new SearchWorkerClient(() => { throw new Error("Worker unavailable"); });
  await expect(client.run(task)).rejects.toMatchObject({ code: "unavailable" });
});

it("바꾸기 작업은 별도 제한 시간과 종료 경로를 가진다", async () => {
  vi.useFakeTimers();
  const worker = new ManualWorker(), client = new SearchWorkerClient(() => worker);
  const pending = client.run({ ...task, kind: "replace" }).catch((error: SearchWorkError) => error);
  await vi.advanceTimersByTimeAsync(4999);
  expect(worker.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ code: "timeout" });
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("작업자 알고리즘도 원문 위치·정규식 캡처·단일 대상 범위를 유지한다", () => {
  const query = { text: "(?<word>[a-z]+)-(\\d+)", regexp: true, caseSensitive: false, replacement: "$2:$<word>" };
  const text = "İ😀 item-12 other-3";
  expect(performSearchTask({ kind: "find", text, query })).toEqual({ kind: "find", matches: [{ from: 4, to: 11 }, { from: 12, to: 19 }] });
  expect(performSearchTask({ kind: "replace", text, query, target: { from: 12, to: 19 } }))
    .toEqual({ kind: "replace", edits: [{ from: 12, to: 19, insert: "3:other" }] });
});

it.each<[number, boolean, number, number]>([
  [4999, true, 5000, 5000], [5000, false, 4999, 0],
  [10000, true, 0, 0], [0, false, 10000, 10000],
])("표시 구간 밖 이동과 문서 전체 순환: %s %s", (current, forward, expected, offset) => {
  const result = performSearchTask({ kind: "find", text: "a ".repeat(10001),
    query: { text: "a", caseSensitive: true, regexp: false },
    navigation: { from: current * 2, to: current * 2 + 1, forward },
  });
  if (result.kind !== "find") throw new Error("Expected find result");
  expect(result).toMatchObject({ index: expected, offset, total: 10001 });
  expect(result.matches.length).toBeLessThanOrEqual(5000);
  expect(result.matches[expected - offset]).toEqual({ from: expected * 2, to: expected * 2 + 1 });
});

it("표시 구간 밖의 커서에서도 바로 이전 일치 항목을 찾는다", () => {
  const result = performSearchTask({ kind: "find", text: "a ".repeat(10001),
    query: { text: "a", caseSensitive: true, regexp: false }, navigation: { from: 15001, to: 15001, forward: false },
  });
  expect(result).toMatchObject({ kind: "find", index: 7500, offset: 5000, total: 10001 });
});

it("빈 정규식의 구간 이동은 보조 평면 문자를 쪼개거나 같은 결과를 반복하지 않는다", () => {
  const result = performSearchTask({ kind: "find", text: "😀".repeat(5001),
    query: { text: "(?=)", caseSensitive: true, regexp: true }, navigation: { from: 9998, to: 9998, forward: true },
  });
  expect(result).toEqual({ kind: "find", offset: 5000, total: 5002, index: 5000,
    matches: [{ from: 10000, to: 10000 }, { from: 10002, to: 10002 }],
  });
});
