// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as bridge from "../api";
import { api, type SearchHit } from "../api";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";
import { BacklinksPanel } from "./BacklinksPanel";

let root: Root;
let host: HTMLDivElement;
const t = makeT("en");
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(bridge, "isInApp").mockReturnValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mount() {
  const io: StoreIO = {
    readDocument: async () => ({ text: "target", meta: { hadBom: false, crlf: false }, mtime: 1, size: 6 }),
    writeDocument: async () => ({ mtime: 2, size: 6 }),
    scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
  };
  const store = new AppStore(io);
  store.state.workspace = "/w";
  await store.openPath("/w/target.md");
  const open = vi.fn();
  const close = vi.fn();
  await act(async () => root.render(<BacklinksPanel store={store} t={t} onClose={close} onOpenHit={open} />));
  return { store, open, close };
}
async function tick(ms = 250) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const hit = (text: string): SearchHit => ({ path: "/w/ref.md", lineNo: 7, line: text });

it("첫 백링크에 Enter로 이동하고 참조 사용처의 줄 번호를 전달한다", async () => {
  vi.spyOn(api, "backlinks").mockResolvedValue([hit("[문구][reference]")]);
  const { open, close } = await mount();
  await tick();
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog);
  expect(host.querySelector(".wssearch-hit.is-sel")?.textContent).toContain("[문구][reference]");
  await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(open).toHaveBeenCalledWith("/w/ref.md", 7);
  expect(close).toHaveBeenCalledTimes(1);
});

it("변경 알림을 합치고 오래된 조회 뒤 최신 저장 내용만 표시한다", async () => {
  let finish!: (hits: SearchHit[]) => void;
  const read = vi.spyOn(api, "backlinks")
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue([hit("[new](target.md)")]);
  const { store } = await mount();
  await tick();
  await act(async () => store.externalChange("/w/target.md", "changed"));
  await tick();
  await act(async () => store.externalChange("/w/target.md", "changed"));
  await tick();
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => finish([hit("stale result")]));
  await tick(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("[new](target.md)");
  expect(host.textContent).not.toContain("stale result");
});

it("읽기 실패는 빈 결과와 구별하고 재시도 후 목록을 표시한다", async () => {
  vi.spyOn(api, "backlinks").mockRejectedValueOnce(new Error("unreadable")).mockResolvedValue([hit("recovered")]);
  await mount();
  await tick();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("unreadable");
  expect(host.textContent).not.toContain(t.backlinksEmpty);
  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === t.wsRetry)!;
  await act(async () => retry.click());
  await tick();
  expect(host.textContent).toContain("recovered");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
