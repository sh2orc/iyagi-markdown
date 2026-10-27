// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppStore, type StoreIO, type Tab } from "../app/store";
import { makeT } from "../i18n";
import { documentTabId, TabBar } from "./TabBar";
import * as bridge from "../api";

const t = makeT("en");
let store: AppStore, host: HTMLDivElement, root: Root, ids: string[];
const close = vi.fn<(tab: Tab) => void>();
const lock = vi.fn<(tab: Tab) => void>();
beforeEach(() => {
  vi.useFakeTimers(); close.mockReset(); lock.mockReset();
  const io: StoreIO = {
    readDocument: async () => ({ text: "", meta: { hadBom: false, crlf: false }, mtime: 1, size: 0 }),
    writeDocument: async () => ({ mtime: 2, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
  };
  store = new AppStore(io);
  for (const text of ["first", "second", "third"]) store.newTabWithContent(text);
  ids = store.state.tabs.map((tab) => tab.id);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<TabBar store={store} t={t} onClose={close} onLock={lock} />));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});
const tab = (index: number) => document.getElementById(documentTabId(ids[index])) as HTMLButtonElement;

it("모든 탭이 닫혀도 다시 열기 버튼을 사용할 수 있다", async () => {
  const button = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t.reopenClosedTab}"]`)!;
  expect(button().disabled).toBe(true);
  await act(async () => { await store.openPath("/closed.md"); });
  act(() => { for (const item of [...store.state.tabs]) store.closeTab(item.id); });
  expect(store.state.tabs).toHaveLength(0);
  expect(button().disabled).toBe(false);
  await act(async () => button().click());
  expect(store.active?.path).toBe("/closed.md");
  expect(button().disabled).toBe(true);
});
const menu = () => host.querySelector<HTMLElement>('[role="menu"]');
const item = (label: string) => [...menu()!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === label)!;
function key(target: HTMLElement, name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event)); return event;
}
function openMenu(index: number) { act(() => tab(index).focus()); key(tab(index), "F10", { shiftKey: true }); }
function drag(target: Element, type: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { effectAllowed: "", dropEffect: "", setData: vi.fn() } });
  act(() => target.dispatchEvent(event));
}

it("비활성 탭의 즐겨찾기 동작도 해당 탭 경로를 사용한다", async () => {
  vi.spyOn(bridge, "isInApp").mockReturnValue(true);
  store.state.tabs[0].path = "/saved.md";
  const set = vi.spyOn(store, "setFavorite").mockResolvedValue(true);
  act(() => store.acceptFavorites({ revision: 1, paths: [] }));
  openMenu(0); await act(async () => item(t.favoriteAdd).click());
  expect(set).toHaveBeenCalledWith("/saved.md", true);
  expect(store.active?.id).toBe(ids[2]);
  openMenu(1); expect(item(t.favoriteAdd)).toBeUndefined();
});

it("방향키는 포커스만 옮기고 제목 버튼을 활성화했을 때 문서를 선택한다", () => {
  const activate = vi.spyOn(store, "activate");
  expect(tab(2).getAttribute("aria-selected")).toBe("true");
  expect(tab(2).getAttribute("aria-controls")).toBe("active-document-panel");
  act(() => tab(2).focus());
  key(tab(2), "ArrowRight"); expect(document.activeElement).toBe(tab(0));
  expect(store.active?.id).toBe(ids[2]);
  key(tab(0), "End"); expect(document.activeElement).toBe(tab(2));
  key(tab(2), "Home"); expect(document.activeElement).toBe(tab(0));
  expect(activate).not.toHaveBeenCalled();
  expect(key(tab(0), "Enter").defaultPrevented).toBe(false);
  // jsdom leaves native Enter-to-click synthesis to the test.
  act(() => tab(0).click());
  expect(activate).toHaveBeenCalledTimes(1);
  expect(activate).toHaveBeenCalledWith(ids[0]);
  expect(store.active?.id).toBe(ids[0]);
  expect([...host.querySelectorAll<HTMLElement>('[role="tab"]')].filter((node) => node.tabIndex === 0)).toEqual([tab(0)]);
});

it("키보드 메뉴는 비활성 탭을 대상으로 하고 Escape 뒤 원래 탭에 포커스를 돌려준다", () => {
  openMenu(1);
  expect(document.activeElement).toBe(item(t.closeTab));
  key(item(t.closeTab), "ArrowDown"); expect(document.activeElement).toBe(item(t.tabLock));
  key(item(t.tabLock), "End"); expect(document.activeElement).toBe(item(t.tabMoveRight));
  key(item(t.tabMoveRight), "Escape");
  expect(menu()).toBeNull(); expect(document.activeElement).toBe(tab(1));
  expect(store.active?.id).toBe(ids[2]);
  openMenu(1); act(() => item(t.tabLock).click());
  expect(lock).toHaveBeenCalledWith(store.state.tabs[1]);
  expect(menu()).toBeNull();
});

it("메뉴로 탭 순서를 바꾸며 끝에서 이동할 수 없는 명령은 건너뛴다", () => {
  openMenu(1); act(() => item(t.tabMoveRight).click());
  expect(store.state.tabs.map((tab) => tab.id)).toEqual([ids[0], ids[2], ids[1]]);
  expect(document.activeElement).toBe(tab(1));
  openMenu(1);
  expect(item(t.tabMoveRight).disabled).toBe(true);
  key(item(t.closeTab), "End"); expect(document.activeElement).toBe(item(t.tabMoveLeft));
});

it("Delete는 기존 닫기 확인에 위임하고 실제 제거 뒤에만 포커스를 복구한다", () => {
  act(() => tab(1).focus());
  key(tab(1), "Delete", { isComposing: true }); key(tab(1), "Delete", { repeat: true });
  expect(close).not.toHaveBeenCalled();
  key(tab(1), "Delete");
  expect(close).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledWith(store.state.tabs[1]);
  expect(document.activeElement).toBe(tab(1));
  act(() => store.closeTab(ids[1]));
  expect(document.activeElement).toBe(tab(2));
  openMenu(2); act(() => store.closeTab(ids[2]));
  expect(menu()).toBeNull(); expect(document.activeElement).toBe(tab(0));
  act(() => store.closeTab(ids[0]));
  expect(document.activeElement).toBe(host.querySelector(".tab-new"));
});

it("휠은 목록을 스크롤하며 문서 선택·확대 제스처를 가로채지 않는다", () => {
  const list = host.querySelector<HTMLElement>(".tabbar-tabs")!;
  Object.defineProperties(list, { scrollWidth: { value: 1000 }, clientWidth: { value: 200 } });
  const wheel = new WheelEvent("wheel", { deltaY: 80, bubbles: true, cancelable: true });
  act(() => list.dispatchEvent(wheel));
  expect(list.scrollLeft).toBe(80); expect(wheel.defaultPrevented).toBe(true);
  expect(store.active?.id).toBe(ids[2]);
  const zoom = new WheelEvent("wheel", { deltaY: 80, ctrlKey: true, bubbles: true, cancelable: true });
  act(() => list.dispatchEvent(zoom));
  expect(list.scrollLeft).toBe(80); expect(zoom.defaultPrevented).toBe(false);
});

it("드래그 중 앞 탭이 닫혀도 원래 잡은 탭을 이동한다", () => {
  drag(tab(1).closest(".tab")!, "dragstart");
  act(() => store.closeTab(ids[0]));
  drag(tab(2).closest(".tab")!, "drop");
  expect(store.state.tabs.map((tab) => tab.id)).toEqual([ids[2], ids[1]]);
});

it("드래그 대상이 닫히거나 잘못된 순번을 전달하면 다른 탭을 이동하지 않는다", () => {
  drag(tab(1).closest(".tab")!, "dragstart");
  act(() => store.closeTab(ids[1]));
  drag(tab(2).closest(".tab")!, "drop");
  const before = [...store.state.tabs];
  act(() => { store.moveTab(-1, 0); store.moveTab(0, 10); store.moveTab(0.5, 1); });
  expect(store.state.tabs).toEqual(before);
  expect(store.state.tabs.map((tab) => tab.id)).toEqual([ids[0], ids[2]]);
});
