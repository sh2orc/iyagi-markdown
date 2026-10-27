// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppStore, type StoreIO } from "./store";
import type { TrashDocument } from "../api";

const reviewed: TrashDocument = { root: "/w", path: "/w/a.md", canonicalRoot: "/w", stamp: "review", size: 5 };
let store: AppStore, io: StoreIO;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  io = {
    readDocument: vi.fn(async () => ({ text: "saved", meta: { hadBom: false, crlf: false }, mtime: 1, size: 5 })),
    writeDocument: vi.fn(async () => ({ mtime: 2, size: 5 })),
    scanWorkspace: vi.fn(async () => ({ tree: [], issues: [] })),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
    draftSave: vi.fn(async () => {}), trashDocument: vi.fn(async () => {}),
    fileRename: vi.fn(async () => []),
  };
  store = new AppStore(io); store.state.workspace = "/w";
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("깨끗한 탭과 같은 파일의 복구 탭을 먼저 보관하고 열린 본문을 유지한다", async () => {
  await store.openPath(reviewed.path);
  const clean = store.active!;
  const recovered = { ...clean, id: "recovered", draftKey: "recovered-key",
    state: clean.state.update({ changes: { from: 0, insert: "unsaved " } }).state, dirty: true };
  store.state.tabs.push(recovered);
  const order: string[] = [];
  io.draftSave = vi.fn(async (draft) => { order.push(draft.content); });
  io.trashDocument = vi.fn(async () => { order.push("trash"); });
  await store.trashDocument(reviewed);
  expect(order.slice(0, 3)).toEqual(["saved", "unsaved saved", "trash"]);
  expect(store.state.tabs).toEqual([clean, recovered]);
  for (const tab of store.state.tabs) {
    expect(tab.conflict).toBe("removed"); expect(tab.dirty).toBe(true);
  }
  expect(recovered.state.doc.toString()).toBe("unsaved saved");
  expect(await store.saveTabById(clean.id)).toBe(false);
  expect(io.writeDocument).not.toHaveBeenCalled();
});

it("복구 초안 쓰기 실패 시 파일과 탭 상태를 그대로 유지한다", async () => {
  await store.openPath(reviewed.path);
  io.draftSave = vi.fn(async () => { throw new Error("disk full"); });
  await expect(store.trashDocument(reviewed)).rejects.toThrow("disk full");
  expect(io.trashDocument).not.toHaveBeenCalled();
  expect(store.active!.conflict).toBeNull(); expect(store.active!.dirty).toBe(false);
  io.draftSave = vi.fn(async () => {});
  await store.trashDocument(reviewed);
  expect(io.trashDocument).toHaveBeenCalledTimes(1);
});

it("보관을 기다리는 동안 본문이나 워크스페이스가 바뀌면 이동하지 않는다", async () => {
  await store.openPath(reviewed.path);
  const wait = deferred<void>();
  const started = deferred<void>();
  io.draftSave = async () => { started.resolve(); await wait.promise; };
  const moving = store.trashDocument(reviewed);
  const rejected = expect(moving).rejects.toMatchObject({ code: "changed" });
  await started.promise;
  const tab = store.active!;
  tab.state = tab.state.update({ changes: { from: 0, insert: "later " } }).state;
  wait.resolve(); await rejected;
  expect(io.trashDocument).not.toHaveBeenCalled();
  io.draftSave = async () => { store.state.workspace = "/other"; };
  await expect(store.trashDocument(reviewed)).rejects.toMatchObject({ code: "changed" });
  expect(io.trashDocument).not.toHaveBeenCalled();
});

it("이동 중 저장·이름 변경·초안 버리기·닫기·중복 이동을 막는다", async () => {
  await store.openPath(reviewed.path);
  const wait = deferred<void>(), started = deferred<void>();
  io.trashDocument = vi.fn(async () => { started.resolve(); await wait.promise; });
  const moving = store.trashDocument(reviewed); await started.promise;
  const tab = store.active!;
  expect(await store.saveDocument(tab.id, "/copy.md")).toBe(false);
  expect(await store.renameDocument(reviewed.path, "/w/renamed.md")).toBe(false);
  expect(await store.createNote(reviewed.path)).toBe(false);
  await expect(store.discardDocuments([tab.id])).rejects.toThrow();
  store.closeTab(tab.id); expect(store.active).toBe(tab);
  await expect(store.trashDocument(reviewed)).rejects.toMatchObject({ code: "changed" });
  expect(io.writeDocument).not.toHaveBeenCalled(); expect(io.fileRename).not.toHaveBeenCalled();
  wait.resolve(); await moving;
  expect(io.trashDocument).toHaveBeenCalledTimes(1);
});

it("이미 시작된 파일 읽기를 기다린 뒤 새로 열린 본문도 보관한다", async () => {
  const wait = deferred<Awaited<ReturnType<StoreIO["readDocument"]>>>();
  io.readDocument = () => wait.promise;
  const opening = store.openPath(reviewed.path);
  const moving = store.trashDocument(reviewed);
  wait.resolve({ text: "loaded", meta: { hadBom: false, crlf: false }, mtime: 1, size: 6 });
  await opening; await moving;
  expect(io.draftSave).toHaveBeenCalledWith(expect.objectContaining({ content: "loaded", path: reviewed.path }));
  expect(store.state.tabs[0].conflict).toBe("removed");
});

it("파일 이동 실패 후 재시도할 수 있고 성공 뒤 목록 실패는 이동 실패로 바뀌지 않는다", async () => {
  await store.openPath(reviewed.path);
  io.trashDocument = vi.fn().mockRejectedValueOnce({ code: "changed" }).mockResolvedValue(undefined);
  await expect(store.trashDocument(reviewed)).rejects.toMatchObject({ code: "changed" });
  expect(store.active!.conflict).toBeNull();
  vi.spyOn(store, "refreshTree").mockRejectedValue(new Error("scan failed"));
  await expect(store.trashDocument(reviewed)).resolves.toBeUndefined();
  expect(store.active!.conflict).toBe("removed");
  expect(io.trashDocument).toHaveBeenCalledTimes(2);
});

it("열린 탭에 복구 저장 기능이 없으면 이동을 거절한다", async () => {
  await store.openPath(reviewed.path); io.draftSave = undefined;
  await expect(store.trashDocument(reviewed)).rejects.toMatchObject({ code: "recoveryUnavailable" });
  expect(io.trashDocument).not.toHaveBeenCalled();
});
