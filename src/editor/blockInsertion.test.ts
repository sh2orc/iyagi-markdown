// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { insertBlock } from "./format";

let view: EditorView;
afterEach(() => { const host = view.dom.parentElement; view.destroy(); host?.remove(); });
function mount(extra: Extension = []) {
  const host = document.createElement("div"); document.body.append(host);
  view = new EditorView({ parent: host, state: EditorState.create({
    doc: "left first\nsecond right", selection: { anchor: 17, head: 5 }, extensions: [history(), extra],
  }) });
}
it("역방향 여러 줄 선택 전체를 교체하고 선택 밖 내용과 실행 취소를 보존한다", () => {
  mount(); const before = view.state.doc.toString();
  expect(insertBlock(view, "one\r\ntwo")).toBe(true);
  expect(view.state.doc.toString()).toBe("left \n\none\ntwo\n\n right");
  expect(view.state.selection.main.head).toBe(view.state.doc.length - " right".length);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(before);
});
it.each(["readonly", "filter"])("%s일 때 변경 성공을 반환하지 않는다", (cause) => {
  mount(cause === "readonly" ? EditorState.readOnly.of(true)
    : EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr));
  const before = view.state;
  expect(insertBlock(view, "---")).toBe(false);
  expect(view.state.doc.eq(before.doc)).toBe(true);
  expect(view.state.selection.eq(before.selection)).toBe(true);
});
