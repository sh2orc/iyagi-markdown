// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import type { AppStore } from "../app/store";
import { asyncEditPlugin } from "../editor/asyncEdit";
import { makeT } from "../i18n";
import { TableDialog } from "./TableDialog";

let host: HTMLDivElement, editorHost: HTMLDivElement, root: Root, view: EditorView;
const t = makeT("en");
beforeEach(() => {
  host = document.createElement("div"); editorHost = document.createElement("div");
  document.body.append(host, editorHost); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); view?.destroy(); host.remove(); editorHost.remove(); });

function mount(source = "before selected after", from = 7, to = 15) {
  view = new EditorView({ parent: editorHost, state: EditorState.create({
    doc: source, selection: { anchor: from, head: to }, extensions: [asyncEditPlugin, history()],
  }) });
  const listeners = new Set<() => void>();
  let snapshot = {};
  const store = { view, active: { id: "first" },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
  };
  const emit = () => { snapshot = {}; listeners.forEach((listener) => listener()); };
  const close = vi.fn();
  act(() => root.render(<TableDialog store={store as unknown as AppStore} t={t} onClose={close} />));
  return { store, emit, close };
}
function input(index = 0) { return host.querySelectorAll<HTMLInputElement>("input")[index]; }
function type(value: string, index = 0) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(index), value);
    input(index).dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(text: string) { return [...host.querySelectorAll("button")].find((node) => node.textContent === text)!; }
function key(value: string, isComposing = false) {
  act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: value, isComposing, bubbles: true, cancelable: true })));
}

it("여러 줄 선택과 앞쪽 편집을 따라가며 다른 커서 위치에 표를 넣지 않는다", () => {
  const source = "before first\nsecond after", from = 7, to = source.indexOf(" after");
  const { close } = mount(source, from, to);
  type("1"); type("1", 1);
  act(() => view.dispatch({ changes: { from: 0, insert: "prefix " }, selection: { anchor: 0 } }));
  const before = view.state.doc.toString();
  act(() => button(t.insert).click());
  expect(view.state.doc.toString()).toBe("prefix before \n\n| Column heading |\n| --- |\n|   |\n\n after");
  expect(view.state.selection.main.head).toBe(0);
  expect(close).toHaveBeenCalledTimes(1);
  act(() => button(t.insert).click());
  expect(close).toHaveBeenCalledTimes(1);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(before);
});

it.each(["tab", "overlap", "readonly", "filter"])("%s 변경·거절 후에는 입력을 남기고 닫지 않는다", (change) => {
  const { store, emit, close } = mount(); type("5");
  act(() => {
    if (change === "tab") {
      store.active = { id: "second" };
      view.setState(EditorState.create({ doc: "another document", extensions: [asyncEditPlugin] }));
    } else if (change === "overlap") view.dispatch({ changes: { from: 8, to: 9, insert: "X" } });
    else if (change === "readonly") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    else view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
    emit();
  });
  const before = view.state.doc.toString();
  key("Enter");
  expect(view.state.doc.toString()).toBe(before);
  expect(close).not.toHaveBeenCalled();
  expect(input().value).toBe("5");
  expect(host.textContent).toContain(change === "filter" ? t.tableInsertFailed : t.tableTargetChanged);
});

it("빈 숫자 입력을 유지하고 범위·정수 검사를 하며 헤더까지 미리 보여 준다", () => {
  const { close } = mount();
  expect(host.querySelectorAll(".trow")).toHaveLength(4);
  for (const invalid of ["", "0", "21", "2.5"]) {
    type(invalid); expect(input().value).toBe(invalid);
    expect(button(t.insert).disabled).toBe(true);
    key("Enter"); expect(close).not.toHaveBeenCalled();
  }
  type("1"); type("2", 1);
  expect(host.querySelectorAll(".trow")).toHaveLength(2);
  expect(host.querySelectorAll(".tcell")).toHaveLength(4);
  expect(button(t.insert).disabled).toBe(false);
});

it("IME 키를 무시하며 수정한 크기는 Escape로 즉시 폐기하지 않는다", () => {
  const { close } = mount(); type("4");
  key("Enter", true); key("Escape", true);
  expect(close).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain(t.tableDiscardPrompt);
  key("Escape");
  expect(host.textContent).toContain(t.tableDiscardPrompt);
  key("Enter"); expect(close).not.toHaveBeenCalled();
  act(() => button(t.commentKeepEditing).click());
  expect(input().value).toBe("4");
  key("Escape"); act(() => button(t.commentDiscard).click());
  expect(close).toHaveBeenCalledTimes(1);
  expect(view.state.doc.toString()).toBe("before selected after");
});
