// 편집 정확성 회귀 — 2026-11 감사에서 재현된 결함들의 방어선.
// (문서를 조용히 망가뜨리던 경로 위주: 자동 빈 줄, 표 재직렬화, 붙여넣기 변환.)
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";

import { createDocState } from "./cm";
import { minimalChange } from "./diff";
import { deleteLines, insertFootnote, tableAddColumn, typePair } from "./format";
import { htmlToMarkdown } from "./htmlPaste";
import { previewHtmlOf } from "./linkPreview";
import { formatTableText } from "./tableFormat";
import { parseTable, serializeTable } from "./widgets";

function mount(doc: string, cursor = 0): EditorView {
  const view = new EditorView({ state: createDocState(doc, "edit"), parent: document.body });
  view.dispatch({ selection: { anchor: cursor } });
  return view;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("표 사이 자동 빈 줄 — 표가 아닌 `|` 줄은 건드리지 않는다", () => {
  it("코드 펜스 안의 셸 파이프 이어 쓰기에 빈 줄을 끼우지 않는다", async () => {
    const doc = "```sh\ncat file \\\n  | grep foo\n```\n";
    const view = mount(doc);
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    const at = doc.indexOf(" \\");
    view.dispatch({ changes: { from: at, insert: "x" }, userEvent: "input.type" });
    await settle();
    expect(view.state.doc.toString()).toBe("```sh\ncat filex \\\n  | grep foo\n```\n");
    view.destroy();
  });

  it("실제 표 행 사이의 일반 문장은 여전히 분리한다", async () => {
    const doc = "| a | b |\n| - | - |\n\n| c | d |\n";
    const view = mount(doc);
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    const at = doc.indexOf("\n\n") + 1;
    view.dispatch({ changes: { from: at, insert: "x" }, userEvent: "input.type" });
    await settle();
    expect(view.state.doc.toString()).toBe("| a | b |\n| - | - |\n\nx\n\n| c | d |\n");
    view.destroy();
  });
});

describe("수식 블록", () => {
  it("내용 줄 끝에 붙은 닫는 $$에서 닫힌다 — 뒤 문서를 삼키지 않는다", () => {
    const doc = "$$\\begin{aligned}\na &= b\n\\end{aligned}$$\n\n# Heading\n\ntext\n";
    const view = mount(doc);
    const tree = ensureSyntaxTree(view.state, doc.length, 5000)!;
    const names: string[] = [];
    tree.iterate({ enter: (node) => { names.push(node.name); } });
    expect(names).toContain("ATXHeading1");
    view.destroy();
  });
});

describe("표 재직렬화", () => {
  it("헤더보다 넓은 행의 셀을 버리지 않는다", () => {
    const parsed = parseTable("| h1 | h2 |\n|:--|--:|\n| x | y | extra |")!;
    expect(serializeTable(parsed)).toContain("extra");
  });

  it("인용구 안 표를 읽는다(이어지는 줄의 `> ` 제외)", () => {
    const parsed = parseTable("| a | b |\n> | - | - |\n> | 1 | 2 |");
    expect(parsed?.header).toEqual(["a", "b"]);
    expect(parsed?.rows).toEqual([["1", "2"]]);
  });

  it("표 정렬이 목록 들여쓰기·인용구 접두를 유지한다", () => {
    expect(formatTableText("| c | d |\n  | - | - |\n  | 333 | 4 |"))
      .toBe("| c   | d |\n  | --- | --- |\n  | 333 | 4 |");
    expect(formatTableText("| c | d |\n> | - | - |\n> | 333 | 4 |"))
      .toBe("| c   | d |\n> | --- | --- |\n> | 333 | 4 |");
  });

  it("빈 본문 행을 구분 줄로 오인하지 않는다 — 열 추가가 모든 행에 적용된다", () => {
    const doc = "| H | H |\n| --- | --- |\n|   |   |\n|   |   |\n";
    const view = mount(doc, 2);
    expect(tableAddColumn(view)).toBe(true);
    const lines = view.state.doc.toString().trimEnd().split("\n");
    const pipes = lines.map((line) => line.split("|").length);
    expect(new Set(pipes).size).toBe(1);
    view.destroy();
  });
});

describe("HTML 붙여넣기", () => {
  it("래퍼 안의 제목·문단·목록을 한 줄로 뭉개지 않는다", () => {
    const md = htmlToMarkdown("<div><h2>Title</h2><p>para one</p><p>para two</p><ul><li>x</li></ul></div>");
    expect(md).toBe("## Title\n\npara one\n\npara two\n\n- x");
  });

  it("구글 문서의 <b> 래퍼 안 문단을 나눈다", () => {
    const md = htmlToMarkdown('<b id="docs-internal-guid-1" style="font-weight:normal"><p>para one</p><p>para two</p></b>');
    expect(md).toBe("para one\n\npara two");
  });

  it("최상위 인라인 조각은 서식을 유지한 한 문단이 된다", () => {
    expect(htmlToMarkdown("글 <b>굵게</b> 글")).toBe("글 **굵게** 글");
  });

  it("인라인 코드는 원문 그대로, 백틱은 대칭 울타리로", () => {
    expect(htmlToMarkdown("<p><code>snake_case*x</code></p>")).toBe("`snake_case*x`");
    expect(htmlToMarkdown("<p><code>a`b</code></p>")).toBe("``a`b``");
  });

  it("목록 항목 안 여러 줄 코드는 펜스 블록으로 남는다", () => {
    const md = htmlToMarkdown("<ul><li>step<pre><code>line1\nline2</code></pre></li></ul>")!;
    expect(md).toContain("- step");
    expect(md).toContain("  ```\n  line1\n  line2\n  ```");
  });
});

describe("링크 호버 미리보기", () => {
  it("이미지 대체 텍스트의 마크업을 이스케이프한다", async () => {
    const html = await previewHtmlOf("![<img src=x onerror=alert(1)>](a.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});

describe("편집 명령", () => {
  it("아포스트로피는 쌍을 만들지 않는다", () => {
    const view = mount("don", 3);
    expect(typePair(view, "'")).toBe(false);
    view.destroy();
    const empty = mount("", 0);
    expect(typePair(empty, "'")).toBe(true);
    expect(empty.state.doc.toString()).toBe("''");
    empty.destroy();
  });

  it("선택이 있어도 각주 삽입이 동작한다", () => {
    const view = mount("alpha beta\n");
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(insertFootnote(view)).toBe(true);
    const text = view.state.doc.toString();
    expect(text.startsWith("[^1] beta\n")).toBe(true);
    expect(text.endsWith("[^1]: ")).toBe(true);
    expect(view.state.selection.main.head).toBe(text.length);
    view.destroy();
  });

  it("마지막 줄 삭제가 동작한다", () => {
    const view = mount("a\nb\nc", 5);
    deleteLines(view);
    expect(view.state.doc.toString()).toBe("a\nb");
    view.destroy();
  });
});

describe("minimalChange", () => {
  it("공통 접두·접미를 뺀 구간만 바꾼다", () => {
    const cases: Array<[string, string]> = [
      ["abcdef", "abXdef"], ["abc", "abc"], ["", "x"], ["x", ""], ["aaa", "aa"], ["aa", "aaa"], ["abab", "ab"],
    ];
    for (const [a, b] of cases) {
      const { from, to, insert } = minimalChange(a, b);
      expect(a.slice(0, from) + insert + a.slice(to)).toBe(b);
      expect(from).toBeLessThanOrEqual(to);
    }
    expect(minimalChange("abcdef", "abXdef")).toEqual({ from: 2, to: 3, insert: "X" });
  });
});
