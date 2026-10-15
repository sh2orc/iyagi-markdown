// 페이지 나눔(`\newpage`) — 판정·삽입·내보내기 변환(HTML) 검증.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";

import { createDocState } from "./cm";
import { insertPageBreak } from "./format";
import { isPageBreakLine } from "./pagebreak";

function viewWith(doc: string, cursor: number): EditorView {
  return new EditorView({
    state: createDocState(doc, "edit").update({ selection: { anchor: cursor } }).state,
    parent: document.body,
  });
}

describe("isPageBreakLine (판정)", () => {
  it("pandoc 매크로 세 종·앞뒤 공백 허용", () => {
    expect(isPageBreakLine("\\newpage")).toBe(true);
    expect(isPageBreakLine(" \\pagebreak ")).toBe(true);
    expect(isPageBreakLine("\\page")).toBe(true);
  });

  it("비슷하지만 나눔이 아닌 것", () => {
    expect(isPageBreakLine("\\newpage 주석")).toBe(false);
    expect(isPageBreakLine("newpage")).toBe(false);
    expect(isPageBreakLine("\\newpages")).toBe(false);
    expect(isPageBreakLine("`\\newpage`")).toBe(false);
    expect(isPageBreakLine("")).toBe(false);
  });
});

describe("insertPageBreak (⇧⌘Enter)", () => {
  it("커서에서 문단을 나눠 자체 문단으로 삽입", () => {
    const view = viewWith("앞 내용뒷 내용", 4); // '뒷' 직전
    insertPageBreak(view);
    expect(view.state.doc.toString()).toBe("앞 내용\n\n\\newpage\n\n뒷 내용");
    view.destroy();
  });

  it("문서 시작이면 빈 문단을 만들지 않는다", () => {
    const view = viewWith("본문", 0);
    insertPageBreak(view);
    expect(view.state.doc.toString()).toBe("\\newpage\n\n본문");
    view.destroy();
  });

  it("빈 줄 직후에는 빈 줄을 더하지 않는다", () => {
    const view = viewWith("문단\n\n커서", 4);
    insertPageBreak(view);
    expect(view.state.doc.toString()).toBe("문단\n\n\\newpage\n\n커서");
    view.destroy();
  });
});
