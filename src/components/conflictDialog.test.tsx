// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppStore, ConflictResolution, Tab } from "../app/store";
import { makeT } from "../i18n";
import { ConflictDialog } from "./Modals";

const { pick } = vi.hoisted(() => ({ pick: vi.fn<() => Promise<string | null>>() }));
vi.mock("../api", () => ({ pickSave: pick }));
const t = makeT("en");
const makeTab = (id: string) => ({ id, path: `/folder/${id}.md`, conflict: "conflict" as Tab["conflict"],
  state: EditorState.create({ doc: `my ${id}` }), dirty: true });
let host: HTMLDivElement, root: Root, tab: ReturnType<typeof makeTab>, store: ReturnType<typeof makeStore>;
function makeStore() {
  let snapshot = { tabs: [tab] };
  const listeners = new Set<() => void>();
  return {
    get state() { return snapshot; }, getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit() { snapshot = { ...snapshot }; listeners.forEach((listener) => listener()); },
    syncActiveState: vi.fn(), saveDocument: vi.fn(async (_id: string, _path: string, _current: () => boolean) => true),
    reloadTab: vi.fn<(_id: string, _keep: boolean, current: () => boolean) => Promise<ConflictResolution>>(async () => ({ status: "applied" })),
    keepMine: vi.fn<(_id: string, current: () => boolean) => Promise<ConflictResolution>>(async () => ({ status: "applied" })),
  };
}
function render() { root.render(<ConflictDialog store={store as unknown as AppStore} tab={tab as Tab} t={t} />); }
function button(label: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!; }
function escape(composing = false) {
  act(() => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", isComposing: composing, bubbles: true, cancelable: true,
  })));
}
beforeEach(() => {
  tab = makeTab("original"); store = makeStore(); pick.mockReset(); pick.mockResolvedValue("/copy.md");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(render);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("처리 중 중복 클릭·Escape를 막고 오류 뒤에 다시 시도할 수 있다", async () => {
  let finish!: (result: ConflictResolution) => void;
  store.reloadTab.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const reload = button(t.extReload);
  act(() => { reload.click(); reload.click(); }); escape();
  expect(store.reloadTab).toHaveBeenCalledTimes(1); expect(store.keepMine).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish({ status: "failed", message: "backup full" }));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("backup full");
  await act(async () => button(t.extReload).click());
  expect(store.reloadTab).toHaveBeenCalledTimes(2);
});

it("삭제된 문서는 닫기로 오인하지 않게 유지 동작과 재생성 조건을 표시한다", () => {
  tab.conflict = "removed"; act(() => store.emit());
  expect(button(t.extKeepRemoved)).toBeDefined(); expect(button(t.close)).toBeUndefined();
  expect(button(t.extReload)).toBeUndefined(); expect(host.textContent).toContain(t.extKeepRemovedHint);
  escape(); expect(store.keepMine).not.toHaveBeenCalled();
});

it("다른 이름 저장은 원래 대상에 적용하고 같은 경로를 거절한다", async () => {
  expect(host.textContent).toContain("/folder/original.md");
  pick.mockResolvedValueOnce(tab.path);
  await act(async () => button(t.extSaveCopy).click());
  expect(store.saveDocument).not.toHaveBeenCalled(); expect(host.textContent).toContain(t.extCopyDifferentPath);
  await act(async () => button(t.extSaveCopy).click());
  expect(store.saveDocument).toHaveBeenCalledWith("original", "/copy.md", expect.any(Function));
});

it("저장 대기 중 본문이 바뀌면 쓰기 승인 함수를 무효화하고 재확인을 안내한다", async () => {
  let finish!: (saved: boolean) => void;
  store.saveDocument.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => button(t.extSaveCopy).click());
  const current = store.saveDocument.mock.calls[0][2];
  expect(current()).toBe(true);
  tab.state = EditorState.create({ doc: "later input" });
  expect(current()).toBe(false);
  await act(async () => finish(false));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.extResolutionChanged);
});

it("파일 선택 중 본문 변경은 저장을 보류한다", async () => {
  let finish!: (path: string) => void;
  pick.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => button(t.extSaveCopy).click());
  tab.state = EditorState.create({ doc: "new input" });
  await act(async () => finish("/copy.md"));
  expect(store.saveDocument).not.toHaveBeenCalled(); expect(host.textContent).toContain(t.extResolutionChanged);
});

it("충돌 대상이 바뀌면 이전 요청의 승인·오류가 새 대화상자에 남지 않는다", async () => {
  let finish!: (result: ConflictResolution) => void;
  store.keepMine.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  act(() => button(t.extKeepMine).click());
  const current = store.keepMine.mock.calls[0][1];
  expect(current()).toBe(true);
  tab = makeTab("other"); store.state.tabs.push(tab); act(render);
  expect(current()).toBe(false);
  await act(async () => finish({ status: "failed", message: "old failure" }));
  expect(host.textContent).not.toContain("old failure"); expect(button(t.extKeepMine).disabled).toBe(false);
});

it("IME Escape는 내 버전 유지로 해석하지 않는다", () => {
  escape(true); expect(store.keepMine).not.toHaveBeenCalled();
  escape(); expect(store.keepMine).toHaveBeenCalledTimes(1);
});
