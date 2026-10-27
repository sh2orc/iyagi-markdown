// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";
import { CommandPalette } from "./CommandPalette";

let root: Root;
let host: HTMLDivElement;
let store: AppStore;
let props: ComponentProps<typeof CommandPalette>;
const t = makeT("en");
const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const io: StoreIO = {
    readDocument: async () => ({ text: "# Heading", meta: { hadBom: false, crlf: false }, mtime: 1, size: 9 }),
    writeDocument: async () => ({ mtime: 2, size: 9 }),
    scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
  };
  store = new AppStore(io);
  props = {
    store, t, onClose: vi.fn(), onOpenShortcuts: vi.fn(), onOpenStats: vi.fn(),
    onOpenRenameHeading: vi.fn(),
    onCloseDocument: vi.fn(),
    onOpenStyle: vi.fn(), onOpenPrint: vi.fn(), onOpenExport: vi.fn(),
  };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoView);
  else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

async function render() { await act(async () => root.render(<CommandPalette {...props} />)); }
function input() { return host.querySelector<HTMLInputElement>('[role="combobox"]')!; }
function selected() { return host.querySelector<HTMLElement>('[role="option"][aria-selected="true"]'); }
async function query(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(value: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
  await act(async () => { input().dispatchEvent(event); });
  return event;
}
const file = (name: string) => ({ path: `/w/${name}.md`, name: `${name}.md` });

it("미저장 탭 닫기는 App의 저장 확인 콜백을 통하며 탭을 직접 버리지 않는다", async () => {
  store.newTabWithContent("Unsaved work");
  const tab = store.active;
  await render(); await query(t.closeTab); await key("Enter");
  expect(props.onCloseDocument).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(store.active).toBe(tab);
  expect(store.active?.dirty).toBe(true);
});

it("닫은 탭 명령은 기록이 생긴 후 표시되고 복원 뒤 사라진다", async () => {
  await store.openPath("/closed.md");
  await render(); await query(t.reopenClosedTab);
  expect(selected()).toBeNull();
  act(() => store.closeTab(store.active!.id));
  expect(selected()?.textContent).toContain(t.reopenClosedTab);
  await key("Enter");
  expect(store.active?.path).toBe("/closed.md");
  expect(selected()).toBeNull();
});

it("최근 작업 폴더는 전체 경로로 검색하고 문서가 아닌 작업 폴더로 연다", async () => {
  store.workspaceHistory.accept({ revision: 1, entries: [{ name: "Notes", path: "/projects/zzqx/Notes" }] });
  const open = vi.spyOn(store, "openWorkspace").mockResolvedValue(undefined);
  await render(); await query("/projects/zzqx"); await key("Enter");
  expect(open).toHaveBeenCalledWith("/projects/zzqx/Notes"); expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("템플릿 명령은 현재 언어의 이름으로 표시하고 선택 화면으로 연결한다", async () => {
  props.t = makeT("ko"); props.onOpenTemplates = vi.fn(); props.onNewFromTemplate = vi.fn();
  await render(); await query("회의록");
  expect(selected()?.textContent).toContain("템플릿으로 새 문서: 회의록");
  await key("Enter");
  expect(props.onOpenTemplates).toHaveBeenCalledWith("meeting");
  expect(props.onNewFromTemplate).not.toHaveBeenCalled();
  expect(store.state.tabs).toHaveLength(0);
});

it("템플릿 바로 생성 콜백도 실행 시점의 날짜와 영어 본문을 사용한다", async () => {
  vi.setSystemTime(new Date(2026, 9, 21, 23, 59));
  props.onNewFromTemplate = vi.fn();
  await render(); await query("Meeting Notes");
  vi.setSystemTime(new Date(2026, 9, 22, 0, 1));
  await key("Enter");
  expect(props.onNewFromTemplate).toHaveBeenCalledWith(expect.stringContaining("## Agenda"));
  expect(props.onNewFromTemplate).toHaveBeenCalledWith(expect.stringContaining("date: 2026-10-22"));
});

it("템플릿 둘러보기 명령은 기존 문서를 수정하거나 새 문서를 만들지 않는다", async () => {
  store.newTabWithContent("existing document");
  const original = store.active!;
  props.onOpenTemplates = vi.fn();
  await render(); await query(t.templateBrowse); await key("Enter");
  expect(props.onOpenTemplates).toHaveBeenCalledWith();
  expect(store.state.tabs).toEqual([original]);
  expect(store.active?.state.doc.toString()).toBe("existing document");
});

it("워크스페이스 밖 즐겨찾기도 검색하고 최근 목록과 겹치는 파일은 한 번만 보여 준다", async () => {
  const target = file("zzqx-favorite");
  store.acceptFavorites({ revision: 1, paths: [target.path] }); store.state.recent = [target];
  const open = vi.spyOn(store, "openPath").mockResolvedValue(undefined);
  await render(); expect(host.textContent).toContain(t.favoritesTitle);
  await query("zzqx-favorite");
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(1);
  await key("Enter"); expect(open).toHaveBeenCalledWith(target.path);
});

it("파일만 일치하면 구분선 다음의 첫 파일을 선택하고 Enter로 연다", async () => {
  store.state.recent = [file("zzqx-target")];
  const open = vi.spyOn(store, "openPath").mockResolvedValue(undefined);
  await render();
  await query("zzqx");
  expect(selected()?.textContent).toContain("zzqx-target.md");
  expect(input().getAttribute("aria-activedescendant")).toBe(selected()?.id);
  await key("ArrowUp");
  expect(selected()?.textContent).toContain("zzqx-target.md");
  await key("Enter");
  expect(open).toHaveBeenCalledWith("/w/zzqx-target.md");
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("목록 앞에 파일이 추가돼도 선택한 경로를 유지하고 삭제되면 유효한 행으로 이동한다", async () => {
  store.state.recent = [file("zzqx-a"), file("zzqx-b")];
  await render(); await query("zzqx"); await key("ArrowDown");
  expect(selected()?.textContent).toContain("zzqx-b.md");
  await act(async () => {
    store.state.recent = [file("zzqx-new"), file("zzqx-a"), file("zzqx-b")];
    store.setSidebar(false);
  });
  expect(selected()?.textContent).toContain("zzqx-b.md");
  await act(async () => {
    store.state.recent = [file("zzqx-new")];
    store.setSidebar(true);
  });
  expect(selected()?.textContent).toContain("zzqx-new.md");
  await query("no-result-zzqx");
  expect(selected()).toBeNull();
  expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  await key("Enter");
  expect(props.onClose).not.toHaveBeenCalled();
});

it("결과는 단일 입력 포커스로 탐색하고 Page 키와 IME 조합을 구별한다", async () => {
  store.state.recent = Array.from({ length: 15 }, (_, i) => file(`zzqx-${String(i).padStart(2, "0")}`));
  await render(); await query("zzqx");
  expect([...host.querySelectorAll<HTMLElement>('[role="option"]')].every((node) => node.tabIndex === -1)).toBe(true);
  expect((await key("Tab")).defaultPrevented).toBe(true);
  expect((await key("Tab", { shiftKey: true })).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(input());
  await key("PageDown");
  expect(selected()?.textContent).toContain("zzqx-10.md");
  await key("PageUp");
  expect(selected()?.textContent).toContain("zzqx-00.md");
  await key("ArrowDown", { isComposing: true });
  await key("Enter", { isComposing: true });
  await key("Escape", { isComposing: true });
  expect(selected()?.textContent).toContain("zzqx-00.md");
  expect(props.onClose).not.toHaveBeenCalled();
});

it("다시 전달된 명령 콜백을 사용하고 연결되지 않은 명령은 표시하지 않는다", async () => {
  const previous = vi.fn(), current = vi.fn();
  props = { ...props, onOpenReview: previous };
  await render(); await query(t.reviewTitle);
  expect(selected()?.textContent).toContain(t.reviewTitle);
  props = { ...props, onOpenReview: current };
  await render(); await key("Enter");
  expect(current).toHaveBeenCalledTimes(1);
  expect(previous).not.toHaveBeenCalled();
  await query(t.wsSearchTitle);
  expect([...host.querySelectorAll('[role="option"]')].some((node) => node.textContent?.includes(t.wsSearchTitle))).toBe(false);
});

it("공백 뒤 @도 제목 검색으로 처리하고 다음 검색어는 첫 결과에서 시작한다", async () => {
  store.newTabWithContent("# First\n\n## Second\n");
  await render(); await query("  @");
  expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
  await key("ArrowDown");
  expect(selected()?.textContent).toContain("Second");
  await query("  @First");
  expect(selected()?.textContent).toContain("First");
  expect(input().getAttribute("aria-controls")).toBe(host.querySelector('[role="listbox"]')?.id);
});
