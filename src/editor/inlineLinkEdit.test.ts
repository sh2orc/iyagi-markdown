// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import MarkdownIt from "markdown-it";
import { asyncEditPlugin } from "./asyncEdit";
import { captureInlineLinkEdit, inlineLinkParts, updateInlineLink } from "./inlineLinkEdit";

const views: EditorView[] = [];
function makeView(source: string) {
  const host = document.createElement("div"); document.body.append(host);
  const view = new EditorView({ parent: host, state: EditorState.create({
    doc: source, extensions: [asyncEditPlugin, history()],
  }) });
  views.push(view); return view;
}
afterEach(() => {
  for (const view of views.splice(0)) { const host = view.dom.parentElement; view.destroy(); host?.remove(); }
});

describe("inline link edits", () => {
  it("괄호·꺾쇠 주소·제목을 읽고 URL만 바꿀 때 라벨 서식과 제목을 그대로 둔다", () => {
    const source = '[**bold** \\[x\\]](<my file(a).md> \'keep "title"\')';
    const parts = inlineLinkParts(source)!;
    expect(parts).toMatchObject({ text: "**bold** [x]", url: "my file(a).md" });
    expect(updateInlineLink(source, parts)).toBe(source);
    const next = updateInlineLink(source, { text: parts.text, url: "new file(b).md?x=1&y=2" });
    expect(next).toBe('[**bold** \\[x\\]](new%20file%28b%29.md?x=1&amp;y=2 \'keep "title"\')');
    expect(inlineLinkParts("[x](https://example.com/a(b)c \"title\")")?.url).toBe("https://example.com/a(b)c");
    expect(inlineLinkParts("[x][ref]")).toBeNull();
  });

  it("새 설명의 괄호·Markdown·엔티티를 리터럴로 표시하고 빈 이미지 설명을 허용한다", () => {
    const label = "[alt] **literal** &copy; \\ path";
    const next = updateInlineLink('![old](x.png "tooltip")', { text: label, url: "new (1).png?a=1&copy;=2" })!;
    const container = document.createElement("div");
    container.innerHTML = new MarkdownIt().render(next);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe(label);
    expect(container.querySelector("img")?.getAttribute("title")).toBe("tooltip");
    expect(inlineLinkParts(next)?.text).toBe(label);
    expect(inlineLinkParts(next)?.url).toBe("new%20%281%29.png?a=1&copy;=2");
    expect(updateInlineLink('![old](x.png "tooltip")', { text: "", url: "x.png" })).toBe('![](x.png "tooltip")');
  });

  it("대상 밖의 변경은 따라가며 선택한 원문만 바꾸고 별도로 실행 취소한다", () => {
    const link = '[old](a.md "keep")';
    const view = makeView(`before ${link} after`);
    const target = captureInlineLinkEdit(view, 7, 7 + link.length)!;
    view.dispatch({ changes: { from: 0, insert: "prefix " }, selection: { anchor: 0 } });
    const before = view.state.doc.toString();
    expect(target.apply({ text: "new", url: "b.md" })).toBe(true);
    expect(view.state.doc.toString()).toBe('prefix before [new](b.md "keep") after');
    expect(view.state.selection.main.head).toBe(0);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(before);
  });

  it.each(["overlap", "tab", "readonly", "cancel", "filter"])("%s 뒤에는 저장 성공으로 처리하지 않는다", (change) => {
    const source = "[old](a.md)";
    const view = makeView(source), target = captureInlineLinkEdit(view, 0, source.length)!;
    if (change === "overlap") view.dispatch({ changes: { from: 2, to: 3, insert: "X" } });
    else if (change === "tab") view.setState(EditorState.create({ doc: source, extensions: [asyncEditPlugin] }));
    else if (change === "readonly") view.setState(EditorState.create({ doc: source, extensions: [asyncEditPlugin, EditorState.readOnly.of(true)] }));
    else if (change === "cancel") target.finish();
    else view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
    const before = view.state.doc.toString();
    expect(target.apply({ text: "new", url: "b.md" })).toBe(false);
    expect(view.state.doc.toString()).toBe(before);
  });
});
