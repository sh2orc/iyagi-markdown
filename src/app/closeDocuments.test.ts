import { EditorState } from "@codemirror/state";
import { expect, it, vi } from "vitest";
import type { AppStore } from "./store";
import { closingDocumentsUnchanged, restoreUnclosedDrafts } from "./closeDocuments";

it.each(["doc", "path", "style", "dirty", "saved", "added", "removed"])("닫기 승인 이후 %s 변경을 발견한다", (kind) => {
  const tab = { id: "a", path: "/a.md", state: EditorState.create({ doc: "text" }),
    docStyle: {} as object, dirty: false, savedText: "text" };
  const store = { state: { tabs: [tab] }, syncActiveState: vi.fn() };
  const current = closingDocumentsUnchanged(store as unknown as AppStore);
  expect(current()).toBe(true);
  if (kind === "doc") tab.state = EditorState.create({ doc: "new content" });
  else if (kind === "path") tab.path = "/renamed.md";
  else if (kind === "style") tab.docStyle = {};
  else if (kind === "dirty") tab.dirty = true;
  else if (kind === "saved") tab.savedText = "other baseline";
  else if (kind === "added") store.state.tabs.push({ ...tab, id: "b" });
  else store.state.tabs = [];
  expect(current()).toBe(false);
});

it("커서만 움직인 경우 닫기 승인을 무효화하지 않는다", () => {
  const tab = { id: "a", path: "/a.md", state: EditorState.create({ doc: "text" }),
    docStyle: null, dirty: false, savedText: "text" };
  const store = { state: { tabs: [tab] }, syncActiveState: vi.fn() };
  const current = closingDocumentsUnchanged(store as unknown as AppStore);
  tab.state = tab.state.update({ selection: { anchor: 3 } }).state;
  expect(current()).toBe(true);
});

it("닫기에 실패하면 버렸지만 열려 있는 본문만 복구 대상으로 되돌린다", () => {
  const tab = { id: "a", state: EditorState.create({ doc: "unsaved" }), dirty: false, savedText: "disk" };
  const store = { state: { tabs: [tab, { ...tab, id: "saved", savedText: "unsaved" }, { ...tab, id: "unrelated" }] },
    restoreDiscardedDocuments: vi.fn() };
  restoreUnclosedDrafts(store as unknown as AppStore, ["a", "saved", "already-closed"]);
  expect(store.restoreDiscardedDocuments).toHaveBeenCalledWith(["a"]);
});
