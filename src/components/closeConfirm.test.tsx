// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppStore } from "../app/store";
import { makeT } from "../i18n";
import { CloseConfirm } from "./Modals";

const { pick } = vi.hoisted(() => ({ pick: vi.fn<() => Promise<string | null>>() }));
vi.mock("../api", () => ({ pickSave: pick }));
const t = makeT("en"), done = vi.fn(), discarded = vi.fn();
const doc = (id: string, path: string | null = `/${id}/note.md`) => ({
  id, path, state: EditorState.create({ doc: `draft ${id}` }), dirty: true,
});
let host: HTMLDivElement, root: Root, store: ReturnType<typeof makeStore>;
let targetIds: string[] | null, requestKey: object;
function makeStore() {
  let snapshot = { tabs: [doc("a"), doc("b")] };
  const listeners = new Set<() => void>();
  const emit = () => { snapshot = { ...snapshot }; listeners.forEach((listener) => listener()); };
  const model = {
    get state() { return snapshot; }, getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit,
    syncActiveState: vi.fn(), flushDocStyles: vi.fn(async () => true), restoreDiscardedDocuments: vi.fn(),
    saveDocument: vi.fn(async (id: string, _path: string) => {
      snapshot.tabs.find((tab) => tab.id === id)!.dirty = false; emit(); return true;
    }),
    discardDocuments: vi.fn(async (ids: string[], current: () => boolean) => {
      if (!current()) throw new Error("changed");
      for (const tab of snapshot.tabs) if (ids.includes(tab.id)) tab.dirty = false;
      emit();
    }),
  };
  return model;
}
function render() { root.render(<CloseConfirm store={store as unknown as AppStore} t={t} targetIds={targetIds}
  requestKey={requestKey} onDone={done} onDiscard={discarded} />); }
function button(label: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!; }
function escape(composing = false) {
  act(() => host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape", isComposing: composing, bubbles: true, cancelable: true,
  })));
}
beforeEach(() => {
  done.mockReset(); discarded.mockReset(); pick.mockReset(); pick.mockResolvedValue("/chosen.md");
  store = makeStore(); targetIds = null; requestKey = {};
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(render);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it("대상 전체 경로를 표시하고 일부 저장 실패 뒤에는 남은 문서만 재시도한다", async () => {
  expect(host.textContent).toContain("/a/note.md"); expect(host.textContent).toContain("/b/note.md");
  store.saveDocument.mockImplementationOnce(async () => { store.state.tabs[0].dirty = false; store.emit(); return true; });
  store.saveDocument.mockResolvedValueOnce(false);
  await act(async () => button(t.dirtySave).click());
  expect(done).not.toHaveBeenCalled(); expect(host.textContent).toContain(t.saveFailed);
  await act(async () => button(t.dirtySave).click());
  expect(store.saveDocument.mock.calls.map(([id]) => id)).toEqual(["a", "b", "b"]);
  expect(done).toHaveBeenCalledWith(true);
});

it("저장 진행 중 중복 제출과 취소를 막고 새 변경이 남으면 확인창을 유지한다", async () => {
  let release!: (saved: boolean) => void;
  store.saveDocument.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const save = button(t.dirtySave);
  act(() => { save.click(); save.click(); }); escape();
  expect(store.saveDocument).toHaveBeenCalledTimes(1); expect(done).not.toHaveBeenCalled();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("0/2");
  // The write succeeded, but edits made afterwards keep the first document dirty.
  await act(async () => release(true));
  expect(done).not.toHaveBeenCalled(); expect(host.textContent).toContain(t.closeChanged);
  expect(button(t.dirtySave).disabled).toBe(false);
});

it("저장 경로 선택 중 대상이 바뀌면 이전 응답으로 저장하거나 닫지 않는다", async () => {
  store.state.tabs[0].path = null; targetIds = ["a"]; act(render);
  let release!: (path: string) => void;
  pick.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  act(() => button(t.dirtySave).click());
  targetIds = ["b"]; requestKey = {}; act(render);
  await act(async () => release("/old-target.md"));
  expect(store.saveDocument).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
  expect(button(t.dirtySave).disabled).toBe(false);
});

it("저장 경로 선택 중 본문이 바뀌면 다시 확인하도록 안내한다", async () => {
  store.state.tabs[0].path = null; targetIds = ["a"]; act(render);
  let release!: (path: string) => void;
  pick.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  act(() => button(t.dirtySave).click());
  store.state.tabs[0].state = EditorState.create({ doc: "new draft" });
  await act(async () => release("/picked.md"));
  expect(store.saveDocument).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
  expect(host.textContent).toContain(t.closeChanged);
});

it("버리기 대기 중 새로 수정된 대상이 생기면 완료하지 않는다", async () => {
  store.state.tabs[1].dirty = false; act(() => store.emit());
  let release!: () => void;
  store.discardDocuments.mockImplementationOnce(async (_ids, current) => {
    await new Promise<void>((resolve) => { release = resolve; });
    if (!current()) throw new Error("changed while discarding");
  });
  act(() => button(t.dirtyDiscard).click());
  store.state.tabs[1].state = EditorState.create({ doc: "new edits" }); store.state.tabs[1].dirty = true;
  await act(async () => release());
  expect(done).not.toHaveBeenCalled(); expect(discarded).not.toHaveBeenCalled();
  expect(host.textContent).toContain("changed while discarding");
});

it("IME Escape는 취소하지 않고 일반 취소는 한 번만 전달한다", () => {
  escape(true); expect(done).not.toHaveBeenCalled();
  escape(); escape(); act(() => button(t.cancel).click());
  expect(done).toHaveBeenCalledTimes(1); expect(done).toHaveBeenCalledWith(false);
});
