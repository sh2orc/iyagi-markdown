// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as bridge from "../api";
import { api, type LinkInspection } from "../api";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";
import { BrokenLinksPanel } from "./BrokenLinksPanel";

const t = makeT("en");
const report: LinkInspection = {
  checked: 2, issues: [], links: [
    { kind: "file", name: "missing.md#heading", from: 9, line: 2, createPath: "/w/missing.md" },
    { kind: "file", name: "image.png", from: 30, line: 3, createPath: null },
  ],
};
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers(); vi.spyOn(bridge, "isInApp").mockReturnValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});
async function mount() {
  const io: StoreIO = {
    readDocument: async () => ({ text: "😀 text\n[missing](missing.md#heading)\n![image](image.png)", meta: { hadBom: false, crlf: false }, mtime: 1, size: 60 }),
    writeDocument: async () => ({ mtime: 2, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
  };
  const store = new AppStore(io); store.state.workspace = "/w"; await store.openPath("/w/source.md");
  const close = vi.fn(), go = vi.fn();
  await act(async () => root.render(<BrokenLinksPanel store={store} t={t} onClose={close} onGoto={go} />));
  return { store, close, go };
}
async function tick(ms = 250) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
function createButton() { return host.querySelector<HTMLButtonElement>(".broken-create")!; }

it("초기 포커스에서 Enter로 검사한 원문 위치에 이동한다", async () => {
  vi.spyOn(api, "inspectLinks").mockResolvedValue(report);
  const { close, go } = await mount(); await tick();
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog);
  await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(go).toHaveBeenCalledWith(9); expect(close).toHaveBeenCalledTimes(1);
});

it("이미지에는 생성 버튼을 주지 않고 Markdown 대상은 확인된 경로로 생성한다", async () => {
  vi.spyOn(api, "inspectLinks").mockResolvedValue(report);
  const create = vi.spyOn(api, "createLinkDocument").mockResolvedValue("/w/missing.md");
  const { store, close } = await mount(); await tick();
  const open = vi.spyOn(store, "openPath").mockResolvedValue();
  expect(host.querySelectorAll(".broken-create")).toHaveLength(1);
  expect(host.textContent).toContain("image.png");
  expect(host.textContent).not.toContain("[[image.png]]");
  await act(async () => createButton().click());
  expect(create).toHaveBeenCalledWith("/w", "/w/source.md", "file", "missing.md#heading");
  expect(open).toHaveBeenCalledWith("/w/missing.md");
  expect(close).toHaveBeenCalledTimes(1);
});

it("오래된 본문 위치는 이동하거나 생성하지 않는다", async () => {
  vi.spyOn(api, "inspectLinks").mockResolvedValue(report);
  const create = vi.spyOn(api, "createLinkDocument");
  const { store, go } = await mount(); await tick();
  const tab = store.active!;
  tab.state = tab.state.update({ changes: { from: 0, insert: "changed\n" } }).state;
  await act(async () => createButton().click());
  expect(create).not.toHaveBeenCalled(); expect(go).not.toHaveBeenCalled();
  expect(host.textContent).toContain(t.brokenTargetChanged);
});

it("검사 실패와 확인 불가를 모두 연결됨으로 표시하지 않는다", async () => {
  const inspect = vi.spyOn(api, "inspectLinks").mockRejectedValueOnce(new Error("incomplete workspace"));
  await mount(); await tick();
  expect(host.textContent).toContain("incomplete workspace");
  expect(host.textContent).not.toContain(t.brokenLinksNone);
  inspect.mockResolvedValue({ links: [], checked: 1, issues: [
    { path: "/outside/note.md", code: "unverified", message: "Outside workspace" },
  ] });
  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent === t.wsRetry)!;
  await act(async () => retry.click()); await tick();
  expect(host.textContent).toContain(t.brokenNoneVerified);
  expect(host.textContent).toContain("Outside workspace");
  expect(host.textContent).not.toContain(t.brokenLinksNone);
});

it("생성 실패는 창을 유지하고 중복 제출을 막는다", async () => {
  vi.spyOn(api, "inspectLinks").mockResolvedValue(report);
  let reject!: (error: Error) => void;
  const create = vi.spyOn(api, "createLinkDocument").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const { close } = await mount(); await tick();
  await act(async () => { createButton().click(); createButton().click(); });
  expect(create).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("already exists")));
  expect(close).not.toHaveBeenCalled();
  expect(host.textContent).toContain("/w/missing.md: Error: already exists");
});

it("생성 중 문서를 전환했으면 파일 생성 후 새 문서로 강제 이동하지 않는다", async () => {
  vi.spyOn(api, "inspectLinks").mockResolvedValue(report);
  let finish!: (path: string) => void;
  vi.spyOn(api, "createLinkDocument").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const { store, close } = await mount(); await tick();
  await act(async () => createButton().click());
  await act(async () => { store.newTabWithContent("another document"); });
  const open = vi.spyOn(store, "openPath").mockResolvedValue();
  await act(async () => finish("/w/missing.md"));
  expect(open).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
});

it("검사 도중 바뀐 문서의 늦은 결과를 버리고 최신 검사만 이어서 실행한다", async () => {
  let finish!: (value: LinkInspection) => void;
  const inspect = vi.spyOn(api, "inspectLinks")
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ links: [], checked: 0, issues: [] });
  const { store } = await mount(); await tick();
  await act(async () => { store.newTabWithContent("latest"); });
  await tick();
  expect(inspect).toHaveBeenCalledTimes(1);
  await act(async () => finish(report)); await tick(0);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(inspect).toHaveBeenLastCalledWith("/w", null, "latest");
  expect(host.querySelectorAll(".broken-link-row")).toHaveLength(0);
});
