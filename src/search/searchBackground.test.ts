// @vitest-environment jsdom
// 이 파일의 테스트는 10,001개 매치 문서의 동기 매칭 구간을 여러 번 돈다 —
// 병렬 스위트의 CPU 경합에서 5초 기본 시간제한을 넘긴 적이 세 번(8~10초,
// 논리 오류가 아니라 시간제한 오류로만 실패). 파일 전체에 넉넉한 제한을 둔다.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { findNext, gotoMatch, prepareReplaceAll, replaceCurrent, searchHighlight, searchStateOf, searchWorkerFactory, setSearchState } from "./searchCm";
import type { SearchQuery } from "./searchMatches";
import { performSearchTask, type SearchRequest } from "./searchWork";
import type { SearchWorkerPort } from "./searchWorkerClient";

class HeldWorker implements SearchWorkerPort {
  onmessage: SearchWorkerPort["onmessage"] = null;
  onerror: SearchWorkerPort["onerror"] = null;
  onmessageerror: SearchWorkerPort["onmessageerror"] = null;
  requests: SearchRequest[] = [];
  terminate = vi.fn();
  postMessage(request: SearchRequest) { this.requests.push(request); }
  finish() {
    const request = this.requests.at(-1)!;
    this.onmessage?.(new MessageEvent("message", { data: { id: request.id, ok: true, result: performSearchTask(request) } }));
  }
}
const views: EditorView[] = [], workers: HeldWorker[] = [];
const factory = () => { const worker = new HeldWorker(); workers.push(worker); return worker; };
const stateOf = (doc: string, create = factory) => EditorState.create({ doc,
  extensions: [searchHighlight(), searchWorkerFactory.of(create)],
});
const query: SearchQuery = { text: "a", regexp: true, caseSensitive: true, replacement: "b" };
function mount(doc = "a a", create = factory) {
  const view = new EditorView({ parent: document.body, state: stateOf(doc, create) });
  views.push(view);
  view.dispatch({ effects: setSearchState.of({ query }) });
  return view;
}
beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
});
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  workers.length = 0; vi.clearAllTimers(); vi.useRealTimers();
});

it("정규식은 상태 갱신에서 계산하지 않고 완료 후 예약한 결과로 이동한다", async () => {
  const view = mount();
  expect(searchStateOf(view.state).pending).toBe(true);
  expect(searchStateOf(view.state).matches).toEqual([]);
  gotoMatch(view, 1);
  await vi.advanceTimersByTimeAsync(60);
  expect(workers).toHaveLength(1);
  workers[0].finish(); await vi.advanceTimersByTimeAsync(0);
  expect(searchStateOf(view.state).pending).toBe(false);
  expect(searchStateOf(view.state).matches).toHaveLength(2);
  expect(view.state.selection.main.from).toBe(2);
});

it("검색 중 커서를 옮기면 완료 결과가 새 커서 위치를 빼앗지 않는다", async () => {
  const view = mount(); gotoMatch(view, 1);
  await vi.advanceTimersByTimeAsync(60);
  view.dispatch({ selection: { anchor: 1 } });
  workers[0].finish(); await vi.advanceTimersByTimeAsync(0);
  expect(view.state.selection.main.head).toBe(1);
  expect(searchStateOf(view.state).matches).toHaveLength(2);
});

it.each(["edit", "tab", "close"])("%s 변경은 작업자를 종료하고 이전 문서의 늦은 결과를 버린다", async (cause) => {
  const view = mount(); await vi.advanceTimersByTimeAsync(60);
  const worker = workers[0], handler = worker.onmessage!, request = worker.requests[0];
  if (cause === "edit") view.dispatch({ changes: { from: 0, insert: "prefix " } });
  else if (cause === "tab") view.setState(stateOf("another document"));
  else view.dispatch({ effects: setSearchState.of({ query: null }) });
  expect(worker.terminate).toHaveBeenCalledOnce();
  handler(new MessageEvent("message", { data: { id: request.id, ok: true, result: performSearchTask(request) } }));
  await vi.advanceTimersByTimeAsync(0);
  expect(searchStateOf(view.state).matches).toEqual([]);
  if (cause === "edit") {
    await vi.advanceTimersByTimeAsync(60);
    workers[1].finish(); await vi.advanceTimersByTimeAsync(0);
    expect(searchStateOf(view.state).matches).toEqual([{ from: 7, to: 8 }, { from: 9, to: 10 }]);
  } else expect(searchStateOf(view.state).query).toBeNull();
});

it("시간 초과는 검색 실패로 남기고 명시적인 재시도로 복구한다", async () => {
  const view = mount();
  await vi.advanceTimersByTimeAsync(2060);
  expect(searchStateOf(view.state)).toMatchObject({ pending: false, error: "timeout", matches: [] });
  view.dispatch({ effects: setSearchState.of({ query, refresh: true }) });
  gotoMatch(view, 0);
  await vi.advanceTimersByTimeAsync(60);
  workers[1].finish(); await vi.advanceTimersByTimeAsync(0);
  expect(searchStateOf(view.state)).toMatchObject({ pending: false, error: null, current: 0 });
});

it("작업자 시작 실패를 결과 없음으로 숨기지 않는다", async () => {
  const view = mount("a a", () => { throw new Error("unavailable"); });
  await vi.advanceTimersByTimeAsync(60);
  expect(searchStateOf(view.state)).toMatchObject({ pending: false, error: "unavailable", matches: [] });
});

it("큰 일반 문자열 문서도 검색 작업자를 사용한다", async () => {
  const view = mount("x".repeat(200_001) + "needle");
  view.dispatch({ effects: setSearchState.of({ query: { ...query, text: "needle", regexp: false } }) });
  expect(searchStateOf(view.state).pending).toBe(true);
  await vi.advanceTimersByTimeAsync(60);
  workers[0].finish(); await vi.advanceTimersByTimeAsync(0);
  expect(searchStateOf(view.state).matches).toEqual([{ from: 200_001, to: 200_007 }]);
});

it("바꾸기 계획 작성 중 편집하면 작업을 취소하고 원문 변경은 사용자의 편집만 남는다", async () => {
  const view = mount();
  const plan = prepareReplaceAll(view, query).catch((error: unknown) => error);
  expect(workers[0].requests[0].kind).toBe("replace");
  view.dispatch({ changes: { from: 0, insert: "prefix " } });
  expect(await plan).toMatchObject({ code: "cancelled" });
  expect(view.state.doc.toString()).toBe("prefix a a");
  expect(workers[0].terminate).toHaveBeenCalledOnce();
});

it("단일 바꾸기도 비동기 경계 뒤 탭 소유권을 다시 확인한다", async () => {
  const view = mount();
  const literal = { ...query, regexp: false };
  view.dispatch({ effects: setSearchState.of({ query: literal }) });
  gotoMatch(view, 0);
  let current = true;
  const result = replaceCurrent(view, literal, () => current);
  current = false;
  expect(await result).toBe(false);
  expect(view.state.doc.toString()).toBe("a a");
});

async function finishPage() {
  await vi.advanceTimersByTimeAsync(60);
  workers.at(-1)!.finish();
  await vi.advanceTimersByTimeAsync(0);
}

// 병렬 스위트의 CPU 경합에서 동기 매칭 구간(10,001건×5 페이지+전체 바꾸기
// 계획)이 기본 5초를 넘긴 적이 두 번(8~10초) — 실제 논리 오류가 아니라
// 시간제한 오류로만 실패하던 것을 시간제한만 넉넉히.
  it("다음·이전은 5,000건 경계와 문서 끝을 넘어 이동하고 전체 순번을 유지한다", { timeout: 60_000 }, async () => {
  const view = mount("a ".repeat(10001));
  view.dispatch({ effects: setSearchState.of({ query: { ...query, regexp: false } }) });
  gotoMatch(view, 4999); findNext(view);
  expect(searchStateOf(view.state).pending).toBe(true);
  await finishPage();
  expect(view.state.selection.main.from).toBe(10000);
  expect(searchStateOf(view.state)).toMatchObject({ offset: 5000, current: 0, total: 10001 });
  findNext(view, false); await finishPage();
  expect(view.state.selection.main.from).toBe(9998);
  expect(searchStateOf(view.state)).toMatchObject({ offset: 0, current: 4999, total: 10001 });
  gotoMatch(view, -1); await finishPage();
  expect(view.state.selection.main.from).toBe(20000);
  expect(searchStateOf(view.state)).toMatchObject({ offset: 10000, current: 0, total: 10001 });
  expect((await prepareReplaceAll(view, { ...query, regexp: false }))?.count).toBe(10001);
  findNext(view); await finishPage();
  expect(view.state.selection.main.from).toBe(0);
  expect(searchStateOf(view.state)).toMatchObject({ offset: 0, current: 0, total: 10001 });
});

it("첫 검색 대기 중 먼 커서에서 이동을 요청해도 처음 구간으로 잘못 순환하지 않는다", async () => {
  const view = mount("a ".repeat(10001));
  view.dispatch({ selection: { anchor: 15001 } }); findNext(view);
  await finishPage();
  expect(view.state.selection.main.head).toBe(15001);
  expect(searchStateOf(view.state).pending).toBe(true);
  await finishPage();
  expect(view.state.selection.main.from).toBe(15002);
  expect(searchStateOf(view.state)).toMatchObject({ offset: 5000, current: 2501, total: 10001 });
});

it("나중 구간을 표시한 뒤 편집하면 앞쪽 결과를 빠뜨리지 않고 재계산한다", async () => {
  const view = mount("a ".repeat(10001));
  view.dispatch({ effects: setSearchState.of({ query: { ...query, regexp: false } }) });
  gotoMatch(view, 4999); findNext(view); await finishPage();
  view.dispatch({ changes: { from: 0, to: 2 } });
  const state = searchStateOf(view.state);
  expect(state.offset).toBe(0);
  expect(state.matches[0]).toEqual({ from: 0, to: 1 });
  expect(state.matches).toHaveLength(5000);
  expect(state.total).toBeNull();
});

it("나중 구간에서 하나 바꾼 뒤에도 뒤쪽의 다음 결과로 이동한다", async () => {
  const view = mount("a ".repeat(10001)), literal = { ...query, regexp: false };
  view.dispatch({ effects: setSearchState.of({ query: literal }) });
  gotoMatch(view, 4999); findNext(view); await finishPage();
  expect(await replaceCurrent(view, literal)).toBe(true);
  expect(view.state.doc.sliceString(10000, 10001)).toBe("b");
  await finishPage();
  expect(view.state.selection.main.from).toBe(10002);
  expect(searchStateOf(view.state)).toMatchObject({ offset: 5000, current: 0, total: 10000 });
});
