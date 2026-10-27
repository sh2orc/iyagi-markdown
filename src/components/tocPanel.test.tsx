// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppStore } from "../app/store";
import { makeT } from "../i18n";
import { TocPanel } from "./TocPanel";

const jump = vi.fn();
const t = makeT("en");
const source = "# Start\n\n## Child\n\n### Detail\n\n# 설치 가이드\n\n## 설치 오류\n\n# Finish\n\n# Appendix\n";
let host: HTMLDivElement, root: Root;
let store: ReturnType<typeof makeStore>;
let opened: boolean;
function makeStore(text: string) {
  const state = EditorState.create({ doc: text });
  const view = { state, dom: document.createElement("div"), scrollDOM: document.createElement("div"),
    posAtCoords: vi.fn(() => 0), focus: vi.fn(), dispatch: vi.fn() };
  let snapshot = { activeId: "first", tabs: [{ id: "first", state, path: null }] };
  const listeners = new Set<() => void>();
  return {
    view, active: snapshot.tabs[0], tocCollapsed: new Set<string>(), lockedTabIds: new Set<string>(),
    bookmarkLinesFor: () => [], toast: vi.fn(),
    revealLocation: ({ pos }: { pos: number }) => jump(view, pos),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    switchTab(text: string) {
      view.state = EditorState.create({ doc: text });
      this.active = { id: "second", state: view.state, path: null };
      snapshot = { activeId: "second", tabs: [this.active] };
      listeners.forEach((listener) => listener());
    },
  };
}
function render() { root.render(<TocPanel store={store as unknown as AppStore} t={t} open={opened} />); }
function mount(text = source) { store = makeStore(text); opened = true; act(render); settle(); }
function settle() { act(() => vi.advanceTimersByTime(150)); }
function input() { return host.querySelector<HTMLInputElement>("input")!; }
function headings() { return [...host.querySelectorAll<HTMLButtonElement>(".toc-item")]; }
function heading(text: string) { return headings().find((button) => button.querySelector(".toc-text")?.textContent === text)!; }
function key(target: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  act(() => target.dispatchEvent(event)); return event;
}
function type(value: string) {
  act(() => {
    input().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.useFakeTimers(); jump.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers();
});

it("일반 목록의 방향키는 실제 포커스·선택 표시를 함께 옮기고 Enter를 중복 처리하지 않는다", () => {
  mount(); key(input(), "ArrowDown");
  expect(document.activeElement).toBe(heading("Start"));
  key(heading("Start"), "ArrowDown");
  expect(document.activeElement).toBe(heading("Child"));
  expect(heading("Child").classList.contains("is-sel")).toBe(true);
  expect(headings().filter((button) => button.tabIndex === 0)).toEqual([heading("Child")]);
  expect(key(heading("Child"), "Enter").defaultPrevented).toBe(false);
  expect(jump).not.toHaveBeenCalled();
  // jsdom does not synthesize a native button click from Enter.
  act(() => heading("Child").click());
  expect(jump).toHaveBeenCalledTimes(1);
  expect(jump).toHaveBeenLastCalledWith(store.view, source.indexOf("## Child"));
  key(heading("Child"), "End"); expect(document.activeElement).toBe(heading("Appendix"));
  key(heading("Appendix"), "Home"); expect(document.activeElement).toBe(heading("Start"));
});

it("좌우 키로 접기·펼치기와 부모·자식 이동을 하고 접힌 자식은 건너뛴다", () => {
  mount(); key(input(), "ArrowDown"); key(heading("Start"), "ArrowLeft");
  expect(heading("Start").getAttribute("aria-expanded")).toBe("false");
  expect(heading("Child")).toBeUndefined();
  key(heading("Start"), "ArrowDown"); expect(document.activeElement).toBe(heading("설치 가이드"));
  key(heading("설치 가이드"), "ArrowUp"); key(heading("Start"), "ArrowRight");
  expect(heading("Start").getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(heading("Start"));
  key(heading("Start"), "ArrowRight"); expect(document.activeElement).toBe(heading("Child"));
  key(heading("Child"), "ArrowRight"); expect(document.activeElement).toBe(heading("Detail"));
  key(heading("Detail"), "ArrowLeft"); expect(document.activeElement).toBe(heading("Child"));
  key(heading("Child"), "Escape"); expect(document.activeElement).toBe(input());
});

it("필터 변경 뒤 결과 순서로 이동하고 짧은 문서·한글 조합형도 검색한다", () => {
  mount(); type("설치".normalize("NFD"));
  expect(headings()).toHaveLength(2);
  key(input(), "ArrowUp"); expect(document.activeElement).toBe(heading("설치 오류"));
  key(heading("설치 오류"), "ArrowUp"); expect(document.activeElement).toBe(heading("설치 가이드"));
  type("Finish"); key(input(), "Enter");
  expect(jump).toHaveBeenLastCalledWith(store.view, source.indexOf("# Finish"));
  type("missing"); key(input(), "Enter");
  expect(jump).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain(t.tocNoMatches);
  key(input(), "Escape"); expect(headings()).toHaveLength(7);
  act(() => store.switchTab("# Only heading")); settle();
  expect(input().getAttribute("aria-label")).toBe(t.tocFilter);
  key(input(), "ArrowDown"); expect(document.activeElement).toBe(heading("Only heading"));
});

it("조합 중 키와 수정키는 가로채지 않고 오래된 문서의 제목으로 이동하지 않는다", () => {
  mount();
  expect(key(input(), "ArrowDown", { isComposing: true }).defaultPrevented).toBe(false);
  expect(key(input(), "ArrowDown", { shiftKey: true }).defaultPrevented).toBe(false);
  type("Child"); key(input(), "Enter", { isComposing: true });
  expect(jump).not.toHaveBeenCalled();
  store.view.state = EditorState.create({ doc: "# Changed" });
  act(() => heading("Child").click());
  expect(jump).not.toHaveBeenCalled();
});

it("닫힘은 예약 계산을 취소하고 재열기 후 현재 문서를 표시한다", () => {
  store = makeStore(source); opened = true; act(render);
  act(() => { opened = false; render(); }); settle();
  expect(headings()).toHaveLength(0);
  act(() => store.switchTab("# New tab")); settle();
  expect(headings()).toHaveLength(0);
  act(() => { opened = true; render(); }); settle();
  expect(heading("New tab")).toBeDefined();
  store.lockedTabIds.add("second"); act(render);
  expect(host.querySelector(".toc-row")?.getAttribute("draggable")).toBe("false");
});
