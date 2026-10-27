// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";
import { FavoriteDocuments } from "./FavoriteDocuments";

const t = makeT("en");
let store: AppStore, host: HTMLDivElement, root: Root, io: StoreIO;
const paths = ["/w/a.md", "/other/a.md", "/w/한글.md".normalize("NFD")];
const open = (path: string) => [...host.querySelectorAll<HTMLButtonElement>(".recent-open")].find((button) => button.title === path)!;
const remove = (path: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${t.favoriteRemove}: ${path}"]`)!;
async function render(query = "", limit = 8) {
  await act(async () => root.render(<FavoriteDocuments store={store} t={t} query={query} limit={limit} />));
}
beforeEach(() => {
  vi.useFakeTimers();
  io = {
    readDocument: async () => ({ text: "", meta: { hadBom: false, crlf: false }, mtime: 1, size: 0 }),
    writeDocument: async () => ({ mtime: 2, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
    getFavorites: vi.fn(async () => ({ revision: 1, paths })),
    setFavorite: vi.fn(async (path) => ({ revision: 2, paths: paths.filter((value) => value !== path) })),
  };
  store = new AppStore(io); store.acceptFavorites({ revision: 1, paths });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

it("다른 폴더의 동명 파일을 구분하며 정확한 경로로 연다", async () => {
  const navigate = vi.spyOn(store, "openPath").mockResolvedValue(undefined);
  await render(); expect(host.querySelectorAll("li")).toHaveLength(3);
  expect(open(paths[0]).textContent).toContain("/w"); expect(open(paths[1]).textContent).toContain("/other");
  await act(async () => open(paths[1]).click());
  expect(navigate).toHaveBeenCalledWith(paths[1]);
});

it("사이드바 필터는 분해된 한글과 전체 경로를 검색한다", async () => {
  await render("한글"); expect(host.querySelectorAll("li")).toHaveLength(1);
  expect(open(paths[2])).toBeDefined();
  await render("/other/"); expect(host.querySelectorAll("li")).toHaveLength(1);
  expect(open(paths[1])).toBeDefined();
  await render("missing"); expect(host.textContent).toContain(t.sidebarNoResults);
});

it("목록을 펼치고 즐겨찾기 해제 후 이웃 문서로 포커스를 복구한다", async () => {
  await render("", 2); expect(host.querySelectorAll("li")).toHaveLength(2);
  act(() => host.querySelector<HTMLButtonElement>(".recent-expand")!.click());
  expect(host.querySelectorAll("li")).toHaveLength(3);
  await act(async () => { remove(paths[0]).focus(); remove(paths[0]).click(); });
  expect(io.setFavorite).toHaveBeenCalledWith(paths[0], false);
  expect(open(paths[0])).toBeUndefined(); expect(document.activeElement).toBe(open(paths[1]));
});

it("늦은 해제 응답이 다른 입력창의 포커스를 빼앗지 않는다", async () => {
  let finish!: (value: { revision: number; paths: string[] }) => void;
  io.setFavorite = () => new Promise((resolve) => { finish = resolve; });
  await render(); await act(async () => { remove(paths[0]).focus(); remove(paths[0]).click(); });
  const input = document.createElement("input"); document.body.append(input); input.focus();
  await act(async () => finish({ revision: 2, paths: paths.slice(1) }));
  expect(document.activeElement).toBe(input); input.remove();
});

it("저장 실패는 항목을 유지하고 목록을 다시 불러올 수 있다", async () => {
  io.setFavorite = async () => { throw new Error("disk full"); };
  await render(); await act(async () => remove(paths[0]).click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("disk full");
  expect(open(paths[0])).toBeDefined(); expect(remove(paths[0]).disabled).toBe(false);
  await act(async () => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
  expect(io.getFavorites).toHaveBeenCalledTimes(1); expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("빈 목록에는 등록 방법을 표시하고 파일 열기 실패로 즐겨찾기를 지우지 않는다", async () => {
  vi.spyOn(store, "openPath").mockRejectedValue(new Error("missing file"));
  await render(); await act(async () => open(paths[0]).click());
  expect(store.state.favorites).toEqual(paths);
  act(() => store.acceptFavorites({ revision: 2, paths: [] }));
  expect(host.textContent).toContain(t.favoritesEmpty);
});

const orderButton = () => host.querySelector<HTMLButtonElement>("button[aria-pressed]")!;
const arrow = (path: string, direction: "up" | "down") => host.querySelector<HTMLButtonElement>(
  `button[aria-label="${direction === "up" ? t.favoriteMoveUp : t.favoriteMoveDown}: ${path}"]`)!;
async function moveKey(path: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true, cancelable: true, ...init });
  await act(async () => { open(path).dispatchEvent(event); }); return event;
}

it("순서 편집은 전체 목록을 펼치고 저장 후 이동한 문서의 포커스와 위치를 알려 준다", async () => {
  io.moveFavorite = vi.fn(async () => ({ revision: 2, paths: [paths[1], paths[0], paths[2]] }));
  await render("", 1); expect(host.querySelectorAll("li")).toHaveLength(1);
  act(() => orderButton().click());
  expect(orderButton().getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelectorAll("li")).toHaveLength(3);
  expect(arrow(paths[0], "up").disabled).toBe(true); expect(arrow(paths[2], "down").disabled).toBe(true);
  await act(async () => { arrow(paths[1], "up").focus(); arrow(paths[1], "up").click(); });
  expect(io.moveFavorite).toHaveBeenCalledWith(paths[1], "up", 1);
  expect([...host.querySelectorAll<HTMLElement>("li")].map((row) => row.dataset.favoritePath)).toEqual([paths[1], paths[0], paths[2]]);
  expect(document.activeElement).toBe(open(paths[1]));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("1/3");
  act(() => orderButton().click());
  expect(host.querySelectorAll("li")).toHaveLength(1); expect(document.activeElement).toBe(orderButton());
});

it("키보드 이동은 편집 모드에서만 처리하며 IME·반복·다른 수정키는 무시한다", async () => {
  io.moveFavorite = vi.fn(async () => ({ revision: 2, paths: [paths[1], paths[0], paths[2]] }));
  await render();
  expect((await moveKey(paths[1])).defaultPrevented).toBe(false);
  act(() => orderButton().click());
  for (const init of [{ isComposing: true }, { repeat: true }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }]) {
    expect((await moveKey(paths[1], init)).defaultPrevented).toBe(false);
  }
  expect(io.moveFavorite).not.toHaveBeenCalled();
  act(() => open(paths[1]).focus());
  expect((await moveKey(paths[1])).defaultPrevented).toBe(true);
  expect(io.moveFavorite).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(open(paths[1]));
});

it("필터가 적용된 부분 목록에서는 전체 순서를 바꾸지 않는다", async () => {
  io.moveFavorite = vi.fn();
  await render("/other/"); expect(orderButton().disabled).toBe(true);
  await render(); act(() => orderButton().click());
  await render("/other/");
  expect(host.querySelector(".favorite-order-actions")).toBeNull();
  expect(host.textContent).toContain(t.favoritesOrderFilter);
  await moveKey(paths[1]); expect(io.moveFavorite).not.toHaveBeenCalled();
  act(() => orderButton().click()); expect(orderButton().getAttribute("aria-pressed")).toBe("false");
});

it("이동 실패는 이전 순서를 유지하고 늦은 완료는 다른 입력창으로부터 포커스를 가져오지 않는다", async () => {
  io.moveFavorite = vi.fn().mockRejectedValueOnce({ code: "io", message: "disk full" });
  await render(); act(() => orderButton().click());
  await act(async () => arrow(paths[1], "up").click());
  expect(store.state.favorites).toEqual(paths); expect(host.textContent).toContain("disk full");
  let finish!: (value: { revision: number; paths: string[] }) => void;
  io.moveFavorite = () => new Promise((resolve) => { finish = resolve; });
  await act(async () => { open(paths[1]).focus(); arrow(paths[1], "up").click(); });
  const input = document.createElement("input"); document.body.append(input); input.focus();
  await act(async () => finish({ revision: 2, paths: [paths[1], paths[0], paths[2]] }));
  expect(document.activeElement).toBe(input); input.remove();
});
