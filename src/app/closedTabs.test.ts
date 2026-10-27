// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStore, type StoreIO } from "./store";

function setup() {
  const readDocument = vi.fn(async (_path: string) => ({
    text: "Saved document", meta: { hadBom: false, crlf: false }, mtime: 1, size: 14,
  }));
  const io: StoreIO = {
    readDocument, writeDocument: async () => ({ mtime: 2, size: 14 }),
    scanWorkspace: async () => ({ tree: [], issues: [] }), saveSession: async () => {},
    setAssetScope: async () => {}, watchPaths: async () => {},
  };
  return { store: new AppStore(io), readDocument };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("닫은 탭 다시 열기", () => {
  it("원래 순서·보기 모드·선택 방향을 복원하며 본문은 다시 읽는다", async () => {
    const { store, readDocument } = setup();
    await store.openPath("/first.md");
    await store.openPath("/middle.md", "source");
    const middle = store.active!;
    store.setLocked(middle.id, true);
    middle.state = middle.state.update({ selection: { anchor: 10, head: 3 } }).state;
    middle.scroll = 250;
    await store.openPath("/last.md");
    store.closeTab(middle.id);
    expect(store.lockedTabIds.has(middle.id)).toBe(false);
    await store.reopenClosedTab();
    expect(store.state.tabs.map((tab) => tab.path)).toEqual(["/first.md", "/middle.md", "/last.md"]);
    expect(store.active?.mode).toBe("source");
    expect(store.lockedTabIds.has(store.active!.id)).toBe(true);
    expect(store.active?.state.selection.main.anchor).toBe(10);
    expect(store.active?.state.selection.main.head).toBe(3);
    expect(store.active?.scroll).toBe(250);
    expect(store.active?.id).not.toBe(middle.id);
    expect(readDocument).toHaveBeenCalledTimes(4);
    expect(store.canReopenClosedTab).toBe(false);
  });

  it("폐기한 수정은 되살리지 않고 짧아진 최신 파일의 범위 안으로 선택을 보정한다", async () => {
    const { store, readDocument } = setup();
    await store.openPath("/saved.md");
    const tab = store.active!;
    tab.state = tab.state.update({ changes: { from: 0, to: tab.state.doc.length, insert: "Discard this private draft" },
      selection: { anchor: 20, head: 5 } }).state;
    tab.dirty = true;
    await store.discardDocuments([tab.id]);
    store.closeTab(tab.id);
    readDocument.mockResolvedValue({ text: "New", meta: { hadBom: false, crlf: false }, mtime: 2, size: 3 });
    await store.reopenClosedTab();
    expect(store.active?.state.doc.toString()).toBe("New");
    expect(store.active?.dirty).toBe(false);
    expect(store.active?.state.selection.main.head).toBe(3);
    expect(store.active?.state.selection.main.anchor).toBe(3);
    expect(store.active?.scroll).toBe(0);
    store.newTabWithContent("Untitled draft");
    await store.discardDocuments([store.active!.id]);
    store.closeTab(store.active!.id);
    expect(store.canReopenClosedTab).toBe(false);
  });

  it("사라진 파일의 열기 실패 후 기록을 유지해 다시 시도한다", async () => {
    const { store, readDocument } = setup();
    await store.openPath("/offline.md");
    store.closeTab(store.active!.id);
    readDocument.mockRejectedValueOnce(new Error("offline"));
    await store.reopenClosedTab();
    expect(store.active).toBeNull();
    expect(store.canReopenClosedTab).toBe(true);
    await store.reopenClosedTab();
    expect(store.active?.path).toBe("/offline.md");
    expect(store.canReopenClosedTab).toBe(false);
  });

  it("이미 다시 열린 문서의 미저장 내용과 선택을 유지하고 중복 탭을 만들지 않는다", async () => {
    const { store, readDocument } = setup();
    await store.openPath("/saved.md");
    store.closeTab(store.active!.id);
    await store.openPath("/saved.md");
    const tab = store.active!;
    tab.state = tab.state.update({ changes: { from: 0, insert: "Unsaved " }, selection: { anchor: 2 } }).state;
    tab.dirty = true;
    const state = tab.state;
    await store.reopenClosedTab();
    expect(store.state.tabs).toHaveLength(1);
    expect(store.active?.state).toBe(state);
    expect(store.active?.dirty).toBe(true);
    expect(readDocument).toHaveBeenCalledTimes(2);
    expect(store.canReopenClosedTab).toBe(false);
  });

  it.each(["edit", "selection", "navigate"])("느린 복원 중 %s 동작을 덮어쓰지 않고 중복 요청을 합친다", async (action) => {
    const { store, readDocument } = setup();
    await store.openPath("/closed.md");
    store.closeTab(store.active!.id);
    store.newTabWithContent("Keep editing here");
    let current = store.active!;
    const doc = await readDocument("/fixture");
    let finish!: (value: typeof doc) => void;
    readDocument.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const reads = readDocument.mock.calls.length;
    const opening = store.reopenClosedTab();
    await store.reopenClosedTab();
    expect(readDocument).toHaveBeenCalledTimes(reads + 1);
    if (action === "edit") current.state = current.state.update({ changes: { from: 0, insert: "New " } }).state;
    else if (action === "selection") current.state = current.state.update({ selection: { anchor: 4 } }).state;
    else { store.newTab(); current = store.active!; }
    const state = current.state;
    finish(doc); await opening;
    expect(store.active).toBe(current);
    expect(store.active?.state).toBe(state);
    expect(store.state.tabs.filter((tab) => tab.path === "/closed.md")).toHaveLength(1);
  });

  it("복원 중 새로 닫은 기록을 보존한다", async () => {
    const { store, readDocument } = setup();
    await store.openPath("/a.md"); const a = store.active!;
    await store.openPath("/b.md"); const b = store.active!;
    store.closeTab(a.id);
    const doc = await readDocument("/fixture");
    let finish!: (value: typeof doc) => void;
    readDocument.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const opening = store.reopenClosedTab();
    store.closeTab(b.id);
    finish(doc); await opening;
    expect(store.canReopenClosedTab).toBe(true);
    await store.reopenClosedTab();
    expect(store.active?.path).toBe("/b.md");
    expect(store.canReopenClosedTab).toBe(false);
  });

  it("창마다 최근 20개만 역순으로 복원한다", async () => {
    const { store } = setup();
    for (let index = 0; index < 22; index++) {
      await store.openPath(`/${index}.md`);
      store.closeTab(store.active!.id);
    }
    expect(setup().store.canReopenClosedTab).toBe(false);
    for (let index = 21; index >= 2; index--) {
      await store.reopenClosedTab();
      expect(store.active?.path).toBe(`/${index}.md`);
    }
    expect(store.canReopenClosedTab).toBe(false);
    expect(store.state.tabs).toHaveLength(20);
  });
});
