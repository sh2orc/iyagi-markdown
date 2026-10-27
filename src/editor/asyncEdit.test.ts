// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { asyncEditPlugin, captureAsyncEdit } from "./asyncEdit";

let view: EditorView;
afterEach(() => { const host = view.dom.parentElement; view.destroy(); host?.remove(); });
function mount(extra: Extension = []) {
  const host = document.createElement("div"); document.body.append(host);
  view = new EditorView({ parent: host, state: EditorState.create({
    doc: "before selected after", selection: { anchor: 7, head: 15 }, extensions: [asyncEditPlugin, history(), extra],
  }) });
}

it("연속 삽입은 첫 선택을 교체한 뒤 삽입 끝을 따라가며 다른 커서를 보존한다", () => {
  mount(); const target = captureAsyncEdit(view, "symbols")!;
  expect(target.replace("😀", "input.symbol", { continueAtEnd: true })).toBe(true);
  expect(view.state.selection.main.head).toBe(9);
  view.dispatch({ changes: { from: 0, insert: "prefix " }, selection: { anchor: 0 } });
  const before = view.state.doc.toString();
  expect(target.replace("α\r\nβ", "input.symbol", { continueAtEnd: true })).toBe(true);
  expect(target.replace("→", "input.symbol", { continueAtEnd: true })).toBe(true);
  expect(view.state.doc.toString()).toBe("prefix before 😀α\nβ→ after");
  expect(view.state.selection.main.head).toBe(0);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("prefix before 😀α\nβ after");
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(before);
});

it.each(["cancel", "supersede", "tab", "readonly", "filter", "overlap"])("%s 이후에는 연속 삽입 대상을 되살리지 않는다", (cause) => {
  mount(); const target = captureAsyncEdit(view, "symbols")!;
  if (cause === "cancel") target.finish();
  else if (cause === "supersede") captureAsyncEdit(view, "symbols");
  else if (cause === "tab") view.setState(EditorState.create({ doc: view.state.doc, extensions: [asyncEditPlugin] }));
  else if (cause === "readonly") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  else if (cause === "filter") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
  else view.dispatch({ changes: { from: 8, to: 9, insert: "X" } });
  const before = view.state.doc.toString();
  expect(target.replace("→", "input.symbol", { continueAtEnd: true })).toBe(false);
  expect(target.current()).toBe(false);
  expect(target.replace("∞", "input.symbol", { continueAtEnd: true })).toBe(false);
  expect(view.state.doc.toString()).toBe(before);
});

it("적용 중 취소된 세션은 실제 편집 성공 후에도 재등록하지 않는다", () => {
  let target: ReturnType<typeof captureAsyncEdit> = null;
  mount(EditorView.updateListener.of((update) => { if (update.docChanged) target?.finish(); }));
  target = captureAsyncEdit(view, "symbols")!;
  expect(target.replace("→", "input.symbol", { continueAtEnd: true })).toBe(true);
  expect(target.current()).toBe(false);
  expect(target.replace("∞", "input.symbol", { continueAtEnd: true })).toBe(false);
  expect(view.state.doc.toString()).toBe("before → after");
});

it("기본 편집은 한 번 적용하면 끝나는 기존 계약을 유지한다", () => {
  mount(); const target = captureAsyncEdit(view, "clipboard")!;
  expect(target.replace("paste", "input.paste")).toBe(true);
  expect(target.current()).toBe(false);
  expect(target.replace("again", "input.paste")).toBe(false);
});
