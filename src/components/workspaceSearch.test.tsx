// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as bridge from "../api";
import { api, type SearchReport } from "../api";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";
import { WorkspaceSearch } from "./WorkspaceSearch";

const t = makeT("en");
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(bridge, "isInApp").mockReturnValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});
const result = (line = "hit"): SearchReport => ({
  hits: [{ path: "/w/ref.md", lineNo: 2, line }], issues: [], truncated: false, filesRead: 1, filesTotal: 1,
});
async function mount() {
  const io: StoreIO = {
    readDocument: async () => ({ text: "hit", meta: { hadBom: false, crlf: false }, mtime: 1, size: 3 }),
    writeDocument: async () => ({ mtime: 2, size: 3 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
  };
  const store = new AppStore(io);
  store.state.workspace = "/w";
  await store.openPath("/w/ref.md");
  const open = vi.fn();
  await act(async () => root.render(<WorkspaceSearch store={store} t={t} initialQuery="hit"
    onClose={() => {}} onOpenHit={open} />));
  return { store, open };
}
async function tick(ms = 200) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function query(value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.startsWith(text))!;
}

it("부분 검색의 누락 사유와 읽은 파일 수를 표시하고 전체 일치 없음으로 표시하지 않는다", async () => {
  vi.spyOn(api, "searchWorkspace").mockResolvedValue({
    hits: [], issues: [{ path: "/w/bad.md", code: "encoding", message: "Invalid UTF-8" }],
    filesRead: 1, filesTotal: 2, truncated: false,
  });
  await mount(); await tick();
  expect(host.textContent).toContain(t.wsSearchIncomplete);
  expect(host.textContent).toContain(t.wsSearchNoMatchPartial);
  expect(host.textContent).not.toContain(t.wsSearchNoMatch);
  expect(host.textContent).toContain(t.f.wsFilesRead(1, 2));
  expect(host.textContent).toContain("/w/bad.md: Invalid UTF-8");
});

it("검색 요청을 직렬화하고 중간 검색어는 건너뛰며 최신 결과만 표시한다", async () => {
  let finish!: (report: SearchReport) => void;
  const read = vi.spyOn(api, "searchWorkspace")
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue(result("latest result"));
  await mount(); await tick();
  await query("middle"); await tick();
  await query("latest"); await tick();
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => finish(result("stale hit")));
  await tick(0);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith("/w", "latest", false);
  expect(host.textContent).toContain("latest result");
  expect(host.textContent).not.toContain("stale hit");
});

it("저장 내용 변경 후 트리 객체가 같아도 검색을 다시 읽는다", async () => {
  const read = vi.spyOn(api, "searchWorkspace").mockResolvedValueOnce(result("before")).mockResolvedValue(result("after"));
  const { store } = await mount(); await tick();
  const tree = store.state.tree;
  await act(async () => store.externalChange("/w/ref.md", "changed"));
  await tick();
  expect(store.state.tree).toBe(tree);
  expect(read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("after");
  expect(host.querySelector(".wssearch-hit")?.textContent).not.toContain("before");
});

it("검색 실패를 빈 결과와 구별하고 재시도한다", async () => {
  vi.spyOn(api, "searchWorkspace").mockRejectedValueOnce(new Error("folder unreadable")).mockResolvedValue(result());
  await mount(); await tick();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("folder unreadable");
  expect(host.textContent).not.toContain(t.wsSearchNoMatch);
  await act(async () => button(t.wsRetry).click());
  await tick();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelectorAll(".wssearch-hit")).toHaveLength(1);
});

it("결과 제한은 백엔드가 확인한 경우에만 표시한다", async () => {
  const read = vi.spyOn(api, "searchWorkspace").mockResolvedValue({ ...result(), truncated: true });
  const { store } = await mount(); await tick();
  expect(host.textContent).toContain(t.f.wsTruncated(2000));
  read.mockResolvedValue(result());
  await act(async () => store.externalChange("/w/ref.md", "changed"));
  await tick();
  expect(host.textContent).not.toContain(t.f.wsTruncated(2000));
});

it("미리보기 후 잠긴 문서는 실제 적용 시점에도 보호한다", async () => {
  vi.spyOn(api, "searchWorkspace").mockResolvedValue(result());
  vi.spyOn(api, "previewReplacement").mockResolvedValue({
    id: 3, files: [{ path: "/w/ref.md", count: 1, before: "hit", after: "new" }], skipped: [],
  });
  const apply = vi.spyOn(api, "applyReplacement").mockResolvedValue({ applied: [], failed: [] });
  const { store } = await mount(); await tick();
  await act(async () => button(t.replacePlaceholder).click());
  await act(async () => button(t.wsPreview).click());
  store.lockedTabIds.add(store.active!.id); // No render before the click.
  await act(async () => button(t.wsApply).click());
  expect(apply).not.toHaveBeenCalled();
  expect(host.textContent).toContain(t.wsDirtyBlocked);
});

it("검색 갱신은 직전 교체 실패의 안내를 지우지 않는다", async () => {
  vi.spyOn(api, "searchWorkspace").mockResolvedValue(result());
  vi.spyOn(api, "previewReplacement").mockResolvedValue({
    id: 4, files: [{ path: "/w/ref.md", count: 1, before: "hit", after: "new" }], skipped: [],
  });
  vi.spyOn(api, "applyReplacement").mockRejectedValue(new Error("write denied"));
  const { store } = await mount(); await tick();
  await act(async () => button(t.replacePlaceholder).click());
  await act(async () => button(t.wsPreview).click());
  await act(async () => button(t.wsApply).click());
  expect(host.textContent).toContain("write denied");
  await act(async () => store.externalChange("/w/ref.md", "changed"));
  await tick();
  expect(host.textContent).toContain("write denied");
});
