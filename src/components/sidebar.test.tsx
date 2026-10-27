// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as bridge from "../api";
import { api, type TreeNode } from "../api";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";
import { Sidebar } from "./Sidebar";

const t = makeT("en"), modal = vi.fn();
let host: HTMLDivElement, root: Root, store: AppStore, tree: TreeNode[];
const file = (name: string, dir = "/w"): TreeNode => ({ kind: "file", name: `${name}.md`, stem: name, path: `${dir}/${name}.md` });
const row = (path: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')].find((item) => item.dataset.treePath === path)!;
const menu = () => host.querySelector<HTMLElement>('[role="menu"]');
const item = (label: string) => [...menu()!.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label)!;
const filter = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
function render() {
  root.render(<Sidebar store={store} tree={tree} workspace={store.state.workspace} activePath="/w/Alpha.md" t={t} open onModalChange={modal} />);
}
function key(target: HTMLElement, name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  act(() => target.dispatchEvent(event)); return event;
}
function focus(path: string) { act(() => row(path).focus()); }
function openMenu(path: string) { focus(path); key(row(path), "F10", { shiftKey: true }); }
function folderName(name: string) {
  const input = host.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function createFolder() { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
const newDocument = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t.ctxNewFile}"]`)!;
const operationButton = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".sidebar-file-operation button")].find((button) => button.textContent === label)!;
function filterName(name: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter(), name);
    filter().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(bridge, "isInApp").mockReturnValue(true);
  vi.spyOn(bridge, "onPendingRenamesChanged").mockResolvedValue(() => {});
  vi.spyOn(api, "pendingRenames").mockResolvedValue([]);
  const io: StoreIO = {
    readDocument: async () => ({ text: "", meta: { hadBom: false, crlf: false }, mtime: 1, size: 0 }),
    writeDocument: async () => ({ mtime: 2, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
  };
  store = new AppStore(io); store.state.workspace = "/w"; store.state.workspaceTreeLoaded = true;
  tree = [file("Alpha"), file("Beta"), file("Bravo"),
    { kind: "dir", name: "Notes", path: "/w/Notes", children: [file("Child", "/w/Notes")] }];
  store.state.tree = tree;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); modal.mockReset();
});

it("파일명을 이어 입력하고 같은 글자를 반복해 이동하며 문서는 자동으로 열지 않는다", async () => {
  const open = vi.spyOn(store, "openPath");
  await act(async () => render()); focus("/w/Alpha.md");
  key(row("/w/Alpha.md"), "b"); expect(document.activeElement).toBe(row("/w/Beta.md"));
  key(row("/w/Beta.md"), "r"); expect(document.activeElement).toBe(row("/w/Bravo.md"));
  vi.setSystemTime(Date.now() + 800);
  key(row("/w/Bravo.md"), "b"); expect(document.activeElement).toBe(row("/w/Beta.md"));
  key(row("/w/Beta.md"), "b"); expect(document.activeElement).toBe(row("/w/Bravo.md"));
  expect(open).not.toHaveBeenCalled();
  expect([...host.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter((node) => node.tabIndex === 0)).toEqual([row("/w/Bravo.md")]);
  expect(key(row("/w/Bravo.md"), "Enter").defaultPrevented).toBe(false);
  await act(async () => row("/w/Bravo.md").click());
  expect(open).toHaveBeenCalledWith("/w/Bravo.md");
});

it("IME·수정키는 탐색으로 소비하지 않고 Escape로 필터에 돌아간다", async () => {
  await act(async () => render()); focus("/w/Alpha.md");
  expect(key(row("/w/Alpha.md"), "ArrowDown", { isComposing: true }).defaultPrevented).toBe(false);
  expect(key(row("/w/Alpha.md"), "End", { metaKey: true }).defaultPrevented).toBe(false);
  expect(key(row("/w/Alpha.md"), "b", { ctrlKey: true }).defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(row("/w/Alpha.md"));
  key(row("/w/Alpha.md"), "Escape"); expect(document.activeElement).toBe(filter());
  key(filter(), "ArrowUp"); expect(document.activeElement).toBe(row("/w/Notes/Child.md"));
});

it("파일명 필터는 분해된 한글도 찾고 입력창의 포커스를 유지한다", async () => {
  tree = [file("한글".normalize("NFD")), file("Other")];
  await act(async () => render());
  const input = filter(); act(() => input.focus());
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "한글");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
  expect(host.querySelector('[role="treeitem"]')?.textContent?.normalize("NFC")).toContain("한글");
  expect(document.activeElement).toBe(input);
});

it("메뉴는 비활성 항목을 건너뛰고 IME Escape를 무시하며 Tab 전에 원래 행으로 복귀한다", async () => {
  vi.mocked(api.pendingRenames).mockImplementation(() => new Promise(() => {}));
  await act(async () => render()); openMenu("/w/Beta.md");
  expect(item(t.ctxRename).disabled).toBe(true);
  expect(document.activeElement).toBe(item(t.ctxDuplicate));
  key(item(t.ctxDuplicate), "ArrowUp"); expect(document.activeElement).toBe(item(t.tabReveal));
  key(item(t.tabReveal), "Home"); expect(document.activeElement).toBe(item(t.ctxDuplicate));
  key(item(t.ctxDuplicate), "Escape", { isComposing: true }); expect(menu()).not.toBeNull();
  expect(key(item(t.ctxDuplicate), "Tab").defaultPrevented).toBe(false);
  expect(menu()).toBeNull(); expect(document.activeElement).toBe(row("/w/Beta.md"));
});

it("파일 메뉴 동작은 원래 행으로 포커스를 돌려주고 정확한 경로를 사용한다", async () => {
  const reveal = vi.spyOn(api, "revealInFinder").mockResolvedValue(undefined);
  await act(async () => render()); openMenu("/w/Beta.md");
  await act(async () => item(t.tabReveal).click());
  expect(reveal).toHaveBeenCalledWith("/w/Beta.md");
  expect(menu()).toBeNull(); expect(document.activeElement).toBe(row("/w/Beta.md"));
});

it("파일 메뉴의 휴지통 이동은 파일을 검토한 뒤 명시적 확인을 기다린다", async () => {
  const reviewed = { root: "/w", path: "/w/Beta.md", canonicalRoot: "/w", stamp: "one", size: 3 };
  const review = vi.spyOn(api, "reviewDocumentTrash").mockResolvedValue(reviewed);
  const move = vi.spyOn(store, "trashDocument").mockResolvedValue(undefined);
  await act(async () => render()); openMenu("/w/Beta.md");
  await act(async () => item(t.ctxTrash).click());
  expect(review).toHaveBeenCalledWith("/w", "/w/Beta.md"); expect(move).not.toHaveBeenCalled();
  expect(modal).toHaveBeenLastCalledWith(true);
  const confirm = [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === t.trashAction)!;
  await act(async () => confirm.click());
  expect(move).toHaveBeenCalledWith(reviewed, expect.any(Function));
  expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(modal).toHaveBeenLastCalledWith(false);
  openMenu("/w/Notes"); expect(item(t.ctxTrash)).toBeUndefined();
});

it("파일 메뉴에서 즐겨찾기 추가와 해제를 명시적으로 요청한다", async () => {
  const set = vi.spyOn(store, "setFavorite").mockResolvedValue(true);
  store.acceptFavorites({ revision: 1, paths: [] });
  await act(async () => render()); openMenu("/w/Beta.md");
  await act(async () => item(t.favoriteAdd).click());
  expect(set).toHaveBeenLastCalledWith("/w/Beta.md", true);
  act(() => store.acceptFavorites({ revision: 2, paths: ["/w/Beta.md"] }));
  await act(async () => render()); openMenu("/w/Beta.md");
  await act(async () => item(t.favoriteRemove).click());
  expect(set).toHaveBeenLastCalledWith("/w/Beta.md", false);
});

it("선택한 파일이 사라지면 남아 있는 부모 또는 이웃 행으로 키보드 포커스를 복구한다", async () => {
  await act(async () => render()); focus("/w/Notes/Child.md");
  tree = tree.map((node) => node.kind === "dir" ? { ...node, children: [] } : node);
  act(render); expect(document.activeElement).toBe(row("/w/Notes"));
  tree = tree.filter((node) => node.kind !== "dir");
  act(render); expect(document.activeElement).toBe(row("/w/Bravo.md"));
  tree = []; act(render); expect(document.activeElement).toBe(filter());
});

it("메뉴의 파일이 사라지면 메뉴를 닫고 이웃으로 복귀한다", async () => {
  await act(async () => render()); openMenu("/w/Beta.md");
  tree = tree.filter((node) => node.path !== "/w/Beta.md");
  act(render);
  expect(menu()).toBeNull(); expect(document.activeElement).toBe(row("/w/Bravo.md"));
});

it("외부 입력창으로 이동한 뒤에는 목록 갱신이 포커스를 가져가지 않는다", async () => {
  await act(async () => render()); focus("/w/Beta.md");
  const input = document.createElement("input"); host.append(input); act(() => input.focus());
  tree = tree.filter((node) => node.path !== "/w/Beta.md");
  act(render); expect(document.activeElement).toBe(input);
});

it("루트 새 폴더 버튼은 루트를 생성 위치로 전달한다", async () => {
  const create = vi.spyOn(api, "newFolderIn").mockResolvedValue("/w/New");
  vi.spyOn(store, "refreshTree").mockResolvedValue(undefined);
  await act(async () => render());
  act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${t.ctxNewFolder}"]`)!.click());
  expect(modal).toHaveBeenLastCalledWith(true);
  folderName("New"); await act(async () => createFolder());
  expect(create).toHaveBeenCalledWith("/w", "/w", "New");
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(modal).toHaveBeenLastCalledWith(false);
});

it("하위 폴더를 만들면 부모를 펼치고 정규화된 이름의 새 행에 포커스를 둔다", async () => {
  const name = "회의", listedPath = `/w/Notes/${name.normalize("NFD")}`;
  const create = vi.spyOn(api, "newFolderIn").mockResolvedValue(`/w/Notes/${name}`);
  vi.spyOn(store, "refreshTree").mockImplementation(async () => {
    tree = tree.map((node) => node.path === "/w/Notes" ? { ...node, children: [
      ...(node.children ?? []), { kind: "dir", name: name.normalize("NFD"), path: listedPath, children: [] },
    ] } : node);
    store.state.tree = tree; render();
  });
  store.collapsedFolders.add("/w/Notes");
  await act(async () => render()); openMenu("/w/Notes");
  act(() => item(t.ctxNewFolder).click());
  folderName(name); await act(async () => createFolder());
  expect(create).toHaveBeenCalledWith("/w", "/w/Notes", name);
  expect(store.collapsedFolders.has("/w/Notes")).toBe(false);
  expect(document.activeElement).toBe(row(listedPath));
  expect(row(listedPath).tabIndex).toBe(0);
});

it("폴더 생성 후 늦은 목록 갱신은 다른 입력창의 포커스를 빼앗지 않는다", async () => {
  vi.spyOn(api, "newFolderIn").mockResolvedValue("/w/New");
  let finish!: () => void;
  vi.spyOn(store, "refreshTree").mockImplementation(() => new Promise((resolve) => {
    finish = () => {
      tree = [...tree, { kind: "dir", name: "New", path: "/w/New", children: [] }];
      store.state.tree = tree; render(); resolve();
    };
  }));
  await act(async () => render());
  act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${t.ctxNewFolder}"]`)!.click());
  folderName("New"); await act(async () => createFolder());
  const input = document.createElement("input"); host.append(input); act(() => input.focus());
  await act(async () => finish()); expect(document.activeElement).toBe(input);
});

it("복제 진행 중 같은 작업과 새 문서 생성을 막고 완료된 경로를 표시한다", async () => {
  let finish!: (path: string) => void;
  const duplicate = vi.spyOn(api, "fileDuplicate").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const open = vi.spyOn(store, "openPath").mockResolvedValue(undefined);
  vi.spyOn(store, "refreshTree").mockResolvedValue(undefined);
  await act(async () => render()); openMenu("/w/Beta.md");
  act(() => { item(t.ctxDuplicate).click(); newDocument().click(); });
  expect(host.textContent).toContain(t.fileDuplicating); expect(newDocument().disabled).toBe(true);
  openMenu("/w/Beta.md"); expect(item(t.ctxDuplicate).disabled).toBe(true);
  act(() => item(t.ctxDuplicate).click());
  await act(async () => finish("/w/Beta 2.md"));
  expect(duplicate).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith("/w/Beta 2.md", undefined, undefined, expect.any(Function));
  expect(host.querySelector(".sidebar-file-operation")?.textContent).toContain("/w/Beta 2.md");
  expect(newDocument().disabled).toBe(false);
});

it("생성 중 새 문서로 이동하고 필터를 바꾸면 늦은 결과를 직접 열 수 있게 남긴다", async () => {
  let finish!: (path: string) => void;
  const create = vi.spyOn(api, "newFileIn").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const open = vi.spyOn(store, "openPath").mockResolvedValue(undefined);
  vi.spyOn(store, "refreshTree").mockResolvedValue(undefined);
  await act(async () => render()); act(() => newDocument().click());
  act(() => store.newTabWithContent("keep writing")); filterName("Alpha");
  await act(async () => finish("/w/new.md"));
  expect(open).not.toHaveBeenCalled(); expect(filter().value).toBe("Alpha");
  expect(host.textContent).toContain(t.fileCreated);
  await act(async () => operationButton(t.fileOperationOpen).click());
  expect(open).toHaveBeenCalledWith("/w/new.md"); expect(create).toHaveBeenCalledTimes(1);
});

it("생성 중 워크스페이스를 바꾸면 새 목록을 다시 읽거나 결과를 자동으로 열지 않는다", async () => {
  let finish!: (path: string) => void;
  vi.spyOn(api, "newFileIn").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const open = vi.spyOn(store, "openPath").mockResolvedValue(undefined);
  const refresh = vi.spyOn(store, "refreshTree").mockResolvedValue(undefined);
  await act(async () => render()); act(() => newDocument().click());
  await act(async () => { await store.openWorkspace("/other"); tree = []; render(); });
  filterName("other query");
  await act(async () => finish("/w/new.md"));
  expect(open).not.toHaveBeenCalled(); expect(refresh).toHaveBeenCalledTimes(1);
  expect(filter().value).toBe("other query"); expect(store.state.workspace).toBe("/other");
  expect(host.querySelector(".sidebar-operation-path")?.textContent).toBe("/w/new.md");
});

it("생성 실패는 원래 경로로 재시도하며 성공 후 열기 실패는 파일을 다시 만들지 않는다", async () => {
  const create = vi.spyOn(api, "newFileIn").mockRejectedValueOnce(new Error("permission denied")).mockResolvedValue("/w/new.md");
  const open = vi.spyOn(store, "openPath").mockRejectedValueOnce(new Error("read failed")).mockResolvedValue(undefined);
  vi.spyOn(store, "refreshTree").mockResolvedValue(undefined);
  const toast = vi.spyOn(store, "toast");
  await act(async () => render()); await act(async () => newDocument().click());
  expect(host.querySelector('.sidebar-file-operation [role="alert"]')?.textContent).toContain("permission denied");
  await act(async () => operationButton(t.wsRetry).click());
  expect(create).toHaveBeenCalledTimes(2); expect(create).toHaveBeenLastCalledWith("/w");
  expect(toast).toHaveBeenCalledWith("read failed", "error");
  expect(operationButton(t.wsRetry)).toBeUndefined();
  await act(async () => operationButton(t.fileOperationOpen).click());
  expect(create).toHaveBeenCalledTimes(2); expect(open).toHaveBeenCalledTimes(2);
});

it("다른 워크스페이스에서는 실패한 원래 위치의 생성 재시도를 비활성화한다", async () => {
  const create = vi.spyOn(api, "newFileIn").mockRejectedValue(new Error("permission denied"));
  await act(async () => render()); await act(async () => newDocument().click());
  await act(async () => { await store.openWorkspace("/other"); tree = []; render(); });
  expect(operationButton(t.wsRetry).disabled).toBe(true);
  act(() => operationButton(t.wsRetry).click()); expect(create).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain(t.fileOperationWorkspace);
});
