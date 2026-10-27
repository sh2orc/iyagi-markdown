// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { asyncEditPlugin } from "../editor/asyncEdit";
import type { AppStore } from "../app/store";
import { makeT } from "../i18n";
import { SymbolPanel } from "./SymbolPanel";

let host: HTMLDivElement, editorHost: HTMLDivElement, root: Root, view: EditorView;
const scrollDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
const t = makeT("en");
beforeEach(() => {
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  host = document.createElement("div"); editorHost = document.createElement("div");
  document.body.append(host, editorHost); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); view?.destroy(); host.remove(); editorHost.remove();
  if (scrollDescriptor) Object.defineProperty(Element.prototype, "scrollIntoView", scrollDescriptor);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});
function mount() {
  view = new EditorView({ parent: editorHost, state: EditorState.create({
    doc: "before selected after", selection: { anchor: 7, head: 15 }, extensions: [asyncEditPlugin],
  }) });
  let snapshot = {};
  const listeners = new Set<() => void>();
  const store = { view, active: { id: "first" }, getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const emit = () => { snapshot = {}; listeners.forEach((listener) => listener()); };
  const close = vi.fn();
  act(() => root.render(<SymbolPanel store={store as unknown as AppStore} t={t} onClose={close} />));
  return { store, close, emit };
}
function input() { return host.querySelector<HTMLInputElement>("input")!; }
function type(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function key(value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
  act(() => input().dispatchEvent(event)); return event;
}
function active() { return host.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')!; }

it("검색창 포커스를 유지하고 처음 선택한 위치에 연속 삽입한다", () => {
  const { close } = mount(); type("∞");
  act(() => view.dispatch({ changes: { from: 0, insert: "prefix " }, selection: { anchor: 0 } }));
  key("Enter");
  type("→"); act(() => active().click());
  expect(view.state.doc.toString()).toBe("prefix before ∞→ after");
  expect(view.state.selection.main.head).toBe(0);
  expect(document.activeElement).toBe(input());
  expect(host.textContent).toContain(`${t.symbolInserted}: → (2)`);
  expect(close).not.toHaveBeenCalled();
});

it("좌우·Home·End와 수정키는 검색어 편집에 남겨 두고 위아래로 결과를 선택한다", () => {
  mount(); type("arrow"); const first = active().id;
  for (const name of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
    expect(key(name).defaultPrevented).toBe(false);
    expect(active().id).toBe(first);
  }
  expect(key("ArrowDown", { shiftKey: true }).defaultPrevented).toBe(false);
  expect(key("ArrowDown").defaultPrevented).toBe(true);
  expect(active().id).not.toBe(first);
  expect(input().getAttribute("aria-activedescendant")).toBe(active().id);
  type("∞");
  expect(active().textContent).toBe("∞");
  expect(active().tabIndex).toBe(-1);
  type("no-symbol-matches-this-query"); key("ArrowDown"); key("Enter");
  expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  expect(view.state.doc.toString()).toBe("before selected after");
});

it("IME·반복 Enter로 삽입하지 않으며 분류 전환 후 검색창으로 돌아온다", () => {
  const { close } = mount(); type("∞");
  key("Enter", { isComposing: true }); key("Enter", { repeat: true }); key("Escape", { isComposing: true });
  expect(view.state.doc.toString()).toBe("before selected after");
  expect(close).not.toHaveBeenCalled();
  type("");
  const category = [...host.querySelectorAll("button")].find((node) => node.textContent === t.symbolCatMath)!;
  act(() => category.click());
  expect(category.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(input());
  expect(active().textContent).toBe("±");
  key("Escape"); expect(close).toHaveBeenCalledTimes(1);
  key("Enter"); expect(view.state.doc.toString()).toBe("before selected after");
});

it.each(["tab", "overlap", "readonly", "filter"])("%s 후 검색을 유지하고 다른 위치에 삽입하지 않는다", (cause) => {
  const { store, emit, close } = mount(); type("∞");
  act(() => {
    if (cause === "tab") {
      store.active = { id: "second" };
      view.setState(EditorState.create({ doc: "another document", extensions: [asyncEditPlugin] }));
    } else if (cause === "overlap") view.dispatch({ changes: { from: 8, to: 9, insert: "X" } });
    else if (cause === "readonly") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    else view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
    emit();
  });
  const before = view.state.doc.toString(); key("Enter");
  expect(view.state.doc.toString()).toBe(before);
  expect(input().value).toBe("∞");
  expect(host.textContent).toContain(cause === "filter" ? t.symbolInsertFailed : t.symbolTargetChanged);
  expect(host.textContent).not.toContain(`${t.symbolInserted}:`);
  expect(close).not.toHaveBeenCalled();
});
