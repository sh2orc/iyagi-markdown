// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";
import { RecentWorkspaces } from "./RecentWorkspaces";

const t = makeT("en");
let host: HTMLDivElement, root: Root, store: AppStore, io: StoreIO;
const paths = ["/first/Notes", "/second/Notes", "/한글/회의"];
const entries = paths.map((path) => ({ path, name: path.split("/").pop()! }));
beforeEach(() => {
  vi.useFakeTimers();
  io = {
    readDocument: async () => ({ text: "", meta: { hadBom: false, crlf: false }, mtime: 1, size: 0 }),
    writeDocument: async () => ({ mtime: 2, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
    updateWorkspaceHistory: async () => ({ revision: 2, entries: entries.slice(1) }),
  };
  store = new AppStore(io); store.workspaceHistory.accept({ revision: 1, entries });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function render(query = "") { await act(async () => root.render(<RecentWorkspaces store={store} t={t} limit={2} query={query} />)); }
function opener(path: string) { return [...host.querySelectorAll<HTMLButtonElement>(".recent-open")].find((button) => button.title === path)!; }
function remove(path: string) { return [...host.querySelectorAll<HTMLButtonElement>(".recent-remove")].find((button) => button.getAttribute("aria-label") === `${t.recentRemove}: ${path}`)!; }

it("동명 폴더를 전체 경로로 구분하고 NFC/NFD 검색과 목록 펼치기를 지원한다", async () => {
  await render(); expect(host.querySelectorAll(".recent-open")).toHaveLength(2);
  expect(host.textContent).toContain("/first/Notes"); expect(host.textContent).toContain("/second/Notes");
  await act(async () => host.querySelector<HTMLButtonElement>(".recent-expand")!.click());
  expect(host.querySelectorAll(".recent-open")).toHaveLength(3);
  await render("회의".normalize("NFD")); expect(host.querySelectorAll(".recent-open")).toHaveLength(1);
  expect(opener("/한글/회의")).toBeTruthy();
});

it("실패한 폴더를 목록에 유지해 다시 열 수 있게 한다", async () => {
  io.scanWorkspace = async () => { throw new Error("offline"); };
  await render(); await act(async () => opener(paths[0]).click());
  expect(store.state.workspaceError).toContain("offline"); expect(opener(paths[0])).toBeTruthy();
  expect(host.textContent).toContain(t.workspaceHistoryOpenFailed);
  io.scanWorkspace = async () => ({ tree: [], issues: [] });
  await act(async () => opener(paths[0]).click()); expect(store.state.workspaceError).toBeNull();
});

it("기록 제거 뒤 이웃 폴더에 포커스를 두고 실제 작업 폴더는 닫지 않는다", async () => {
  store.state.workspace = paths[0]; await render();
  await act(async () => { remove(paths[0]).focus(); remove(paths[0]).click(); });
  expect(store.state.workspace).toBe(paths[0]);
  expect(document.activeElement).toBe(opener(paths[1]));
});

it("다른 입력창으로 이동한 포커스는 늦은 기록 제거가 가져오지 않는다", async () => {
  let finish!: (value: { revision: number; entries: typeof entries }) => void;
  io.updateWorkspaceHistory = () => new Promise((resolve) => { finish = resolve; });
  const outside = document.createElement("input"); document.body.append(outside);
  try {
    await render(); await act(async () => { remove(paths[0]).focus(); remove(paths[0]).click(); });
    outside.focus(); await act(async () => finish({ revision: 2, entries: entries.slice(1) }));
    expect(document.activeElement).toBe(outside);
  } finally { outside.remove(); }
});
