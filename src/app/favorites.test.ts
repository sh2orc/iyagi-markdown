// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppStore, type StoreIO } from "./store";
import type { FavoritesSnapshot } from "../api";

let store: AppStore, io: StoreIO;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.useFakeTimers();
  io = {
    readDocument: async () => ({ text: "", meta: { hadBom: false, crlf: false }, mtime: 1, size: 0 }),
    writeDocument: async () => ({ mtime: 2, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
    getFavorites: vi.fn(async () => ({ revision: 0, paths: [] })),
    setFavorite: vi.fn(async (path, present) => ({ revision: 1, paths: present ? [path] : [] })),
  };
  store = new AppStore(io);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("새 창의 목록과 늦은 조회 응답이 뒤섞여도 가장 최신 목록을 유지한다", async () => {
  const wait = deferred<FavoritesSnapshot>(); io.getFavorites = () => wait.promise;
  const loading = store.loadFavorites(); expect(store.state.favoritesLoading).toBe(true);
  store.acceptFavorites({ revision: 3, paths: ["/b.md"] });
  expect(store.state.favoritesLoading).toBe(false);
  wait.resolve({ revision: 1, paths: ["/a.md"] }); await loading;
  expect(store.state.favorites).toEqual(["/b.md"]); expect(store.state.favoritesLoaded).toBe(true);
});

it("새 스냅샷 이후 늦은 조회 실패가 성공 상태를 덮지 않는다", async () => {
  const wait = deferred<FavoritesSnapshot>(); io.getFavorites = () => wait.promise;
  const loading = store.loadFavorites();
  store.acceptFavorites({ revision: 3, paths: ["/b.md"] });
  wait.reject(new Error("old read failed")); await loading;
  expect(store.state.favoritesError).toBeNull(); expect(store.state.favoritesLoading).toBe(false);
});

it("저장 실패 시 표시 중인 목록을 유지하며 명시적인 동일 동작을 다시 시도한다", async () => {
  store.acceptFavorites({ revision: 1, paths: ["/a.md"] });
  io.setFavorite = vi.fn().mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValueOnce({ revision: 2, paths: [] });
  expect(await store.setFavorite("/a.md", false)).toBe(false);
  expect(store.isFavorite("/a.md")).toBe(true); expect(store.state.favoritesError).toContain("disk full");
  expect(store.state.favoritesBusy).toBe(false);
  expect(await store.setFavorite("/a.md", false)).toBe(true);
  expect(store.state.favorites).toEqual([]); expect(store.state.favoritesError).toBeNull();
  expect(io.setFavorite).toHaveBeenNthCalledWith(1, "/a.md", false);
  expect(io.setFavorite).toHaveBeenNthCalledWith(2, "/a.md", false);
});

it("중복 추가를 토글로 뒤집지 않고 요청 순서대로 적용한다", async () => {
  const wait = deferred<FavoritesSnapshot>();
  io.setFavorite = vi.fn().mockImplementationOnce(() => wait.promise)
    .mockResolvedValueOnce({ revision: 1, paths: ["/a.md"] });
  const first = store.setFavorite("/a.md", true), second = store.setFavorite("/a.md", true);
  expect(store.state.favoritesBusy).toBe(true); expect(store.state.favorites).toEqual([]);
  await Promise.resolve(); expect(io.setFavorite).toHaveBeenCalledTimes(1);
  wait.resolve({ revision: 1, paths: ["/a.md"] });
  expect(await first).toBe(true); expect(await second).toBe(true);
  expect(io.setFavorite).toHaveBeenNthCalledWith(2, "/a.md", true);
  expect(store.state.favorites).toEqual(["/a.md"]); expect(store.state.favoritesBusy).toBe(false);
});

it("휴지통 이동·워크스페이스 전환·최근 목록 삭제가 즐겨찾기를 제거하지 않는다", async () => {
  store.acceptFavorites({ revision: 1, paths: ["/w/a.md"] });
  store.state.workspace = "/w";
  io.trashDocument = async () => {};
  await store.trashDocument({ root: "/w", path: "/w/a.md", canonicalRoot: "/w", stamp: "one", size: 1 });
  store.state.workspace = "/other";
  store.acceptRecent({ revision: 1, entries: [] });
  expect(store.state.favorites).toEqual(["/w/a.md"]);
});

it("목록 조회 실패 후 재시도와 이름 변경 뒤 새 경로 조회를 지원한다", async () => {
  io.getFavorites = vi.fn().mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ revision: 1, paths: ["/w/a.md"] })
    .mockResolvedValueOnce({ revision: 2, paths: ["/w/b.md"] });
  await store.loadFavorites(); expect(store.state.favoritesLoaded).toBe(false);
  expect(store.state.favoritesError).toContain("offline");
  await store.loadFavorites(); expect(store.state.favoritesError).toBeNull();
  io.fileRename = async () => [];
  expect(await store.renameDocument("/w/a.md", "/w/b.md")).toBe(true);
  expect(store.state.favorites).toEqual(["/w/b.md"]);
});

it("순서 변경은 확인한 순번을 전달하고 저장 전 표시 순서를 바꾸지 않는다", async () => {
  store.acceptFavorites({ revision: 5, paths: ["/a.md", "/b.md"] });
  const wait = deferred<FavoritesSnapshot>(); io.moveFavorite = vi.fn(() => wait.promise);
  const moving = store.moveFavorite("/b.md", "up");
  expect(store.state.favorites).toEqual(["/a.md", "/b.md"]); expect(store.state.favoritesBusy).toBe(true);
  expect(await store.moveFavorite("/b.md", "up")).toBe(false);
  expect(io.moveFavorite).toHaveBeenCalledWith("/b.md", "up", 5);
  wait.resolve({ revision: 6, paths: ["/b.md", "/a.md"] });
  expect(await moving).toBe(true); expect(store.state.favorites).toEqual(["/b.md", "/a.md"]);
  expect(await store.moveFavorite("/b.md", "up")).toBe(false);
  expect(io.moveFavorite).toHaveBeenCalledTimes(1);
});

it("요청 직전 다른 창의 목록을 받으면 이전 순서 기준의 이동을 보내지 않는다", async () => {
  store.acceptFavorites({ revision: 5, paths: ["/a.md", "/b.md"] });
  io.moveFavorite = vi.fn();
  const moving = store.moveFavorite("/b.md", "up");
  store.acceptFavorites({ revision: 6, paths: ["/a.md", "/new.md", "/b.md"] });
  expect(await moving).toBe(false); expect(io.moveFavorite).not.toHaveBeenCalled();
  expect(store.state.favoritesError).toBeTruthy();
  expect(store.state.favorites).toEqual(["/a.md", "/new.md", "/b.md"]);
});

it("서버 충돌과 쓰기 실패는 기존 순서를 유지하고 다시 읽기를 제공한다", async () => {
  store.acceptFavorites({ revision: 5, paths: ["/a.md", "/b.md"] });
  io.moveFavorite = vi.fn().mockRejectedValueOnce({ code: "changed" })
    .mockRejectedValueOnce({ code: "io", message: "disk full" });
  expect(await store.moveFavorite("/b.md", "up")).toBe(false);
  expect(store.state.favoritesError).not.toContain("[object Object]");
  expect(store.state.favorites).toEqual(["/a.md", "/b.md"]);
  expect(await store.moveFavorite("/b.md", "up")).toBe(false);
  expect(store.state.favoritesError).toBe("disk full");
  io.getFavorites = async () => ({ revision: 6, paths: ["/b.md", "/a.md"] });
  await store.loadFavorites();
  expect(store.state.favorites).toEqual(["/b.md", "/a.md"]); expect(store.state.favoritesError).toBeNull();
});
