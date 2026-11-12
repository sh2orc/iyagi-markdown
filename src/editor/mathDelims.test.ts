// MathJax식 수식 구분자(\[ … \], \( … \)) — 편집기 문법·미리보기·내보내기.
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

import { createDocState } from "./cm";
import { __testing } from "./livePreview";
import { normalizeMathDelimiters } from "./mathDelims";
import { renderExportBody } from "../export/html";

const DOC = [
  "전체 토큰 감소율:",
  "",
  "\\[",
  "R_{all}=\\frac{a}{b}\\times100",
  "\\approx74.19\\%",
  "\\]",
  "",
  "한 줄: \\(x^2\\) 와 \\( y \\).",
  "",
  "\\[ E = mc^2 \\]",
  "",
  "# 뒤 제목",
  "",
  "끝",
].join("\n");

function nodes(doc: string): Array<{ name: string; text: string }> {
  const view = new EditorView({ state: createDocState(doc, "edit"), parent: document.body });
  const tree = ensureSyntaxTree(view.state, doc.length, 5000)!;
  const out: Array<{ name: string; text: string }> = [];
  tree.iterate({ enter: (n) => { out.push({ name: n.name, text: doc.slice(n.from, n.to) }); } });
  view.destroy();
  return out;
}

describe("편집기 문법", () => {
  it("\\[ … \\] 블록과 \\( … \\) 인라인을 수식 노드로 읽고 뒤 문서를 삼키지 않는다", () => {
    const found = nodes(DOC);
    const blocks = found.filter((n) => n.name === "MathBlock").map((n) => n.text);
    expect(blocks).toEqual(["\\[\nR_{all}=\\frac{a}{b}\\times100\n\\approx74.19\\%\n\\]", "\\[ E = mc^2 \\]"]);
    expect(found.filter((n) => n.name === "InlineMath").map((n) => n.text)).toEqual(["\\(x^2\\)", "\\( y \\)"]);
    expect(found.some((n) => n.name === "ATXHeading1")).toBe(true);
  });

  it("문장 속 대괄호·괄호 이스케이프와 코드는 수식이 아니다", () => {
    const found = nodes("글 \\[literal\\] 과 \\(열기만\n\n`\\(x\\)`\n");
    expect(found.some((n) => n.name === "MathBlock" || n.name === "InlineMath")).toBe(false);
  });

  it("수식 위젯에 구분자를 뗀 LaTeX가 들어간다", () => {
    const view = new EditorView({ state: createDocState(`${DOC}\n\n`, "edit"), parent: document.body });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const latex: string[] = [];
    const cursor = __testing.buildDecorations(view).iter();
    while (cursor.value) {
      const widget = (cursor.value as unknown as { spec: { widget?: { constructor: { name: string }; latex?: string } } }).spec.widget;
      if (widget?.constructor.name === "MathWidget") latex.push(String(widget.latex).trim());
      cursor.next();
    }
    view.destroy();
    expect(latex).toEqual(["R_{all}=\\frac{a}{b}\\times100\n\\approx74.19\\%", "x^2", "y", "E = mc^2"]);
  });
});

describe("내보내기 정규화", () => {
  it("$$·$ 표기로 바꾸되 줄 수와 코드는 그대로 둔다", () => {
    const source = `${DOC}\n\n\`\`\`\n\\[\nx\n\\]\n\`\`\`\n\n글 \\[literal\\] \`\\(a\\)\`\n`;
    const out = normalizeMathDelimiters(source);
    expect(out.split("\n").length).toBe(source.split("\n").length);
    expect(out).toContain("$$\nR_{all}=\\frac{a}{b}\\times100\n\\approx74.19\\%\n$$");
    expect(out).toContain("한 줄: $x^2$ 와 $y$.");
    expect(out).toContain("$$E = mc^2$$");
    expect(out).toContain("```\n\\[\nx\n\\]\n```");
    expect(out).toContain("글 \\[literal\\] `\\(a\\)`");
  });

  it("HTML 내보내기에서 수식으로 렌더된다", async () => {
    const body = await renderExportBody(DOC, { title: "T", baseDir: "", theme: "light", inlineImages: false });
    expect(body.match(/class="katex/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(body).not.toContain("\\[");
    expect(body).not.toContain("math-fallback");
  });
});
