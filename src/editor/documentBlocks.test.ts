// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { insertPageBreak, insertToc } from "./format";

let view: EditorView;
function mount(source: string, extra: Extension = []) {
  const host = document.createElement("div"); document.body.append(host);
  view = new EditorView({ parent: host, state: EditorState.create({ doc: source, extensions: [history(), extra] }) });
}
afterEach(() => { const host = view.dom.parentElement; view.destroy(); host?.remove(); });

it("목차로 교체되는 제목을 제외하고 남은 중복 제목의 앵커를 다시 계산한다", () => {
  const source = "# Same\n\n# Same\n\nTail";
  mount(source);
  expect(insertToc(view, { from: 0, to: source.indexOf("# Same", 1) })).toBe(true);
  expect(view.state.doc.toString()).toBe("- [Same](#same)\n\n# Same\n\nTail");
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
});

it("제목 중간의 목차 명령은 문단을 나누고 실제로 남는 제목에 연결한다", () => {
  const source = "# Head /toc tail\n\n## Child";
  mount(source);
  expect(insertToc(view, { from: 7, to: 11 })).toBe(true);
  expect(view.state.doc.toString()).toBe("# Head \n\n- [Head](#head)\n  - [Child](#child)\n\n tail\n\n## Child");
});

it.each(["toc", "pagebreak"])("%s 삽입의 트랜잭션 거절은 성공이 아니다", (kind) => {
  const source = "# Heading\n\nselected";
  mount(source, EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr));
  const insert = kind === "toc" ? insertToc : insertPageBreak;
  expect(insert(view, { from: 11, to: source.length })).toBe(false);
  expect(view.state.doc.toString()).toBe(source);
});
