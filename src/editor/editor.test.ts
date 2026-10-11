// 에디터 조각 단위 테스트 — 수식 문법 노드, 표 파서, 검색 매칭.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";

import { mathSyntax } from "./mathSyntax";
import { parseTable } from "./widgets";
import { computeMatches } from "../search/searchCm";
import { createDocState } from "./cm";

const parse = (doc: string) => {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [GFM, mathSyntax], codeLanguages: languages, addKeymap: false }),
    ],
  });
  ensureSyntaxTree(state, doc.length + 100, 1000);
  return syntaxTree(state);
};

const nodeNames = (doc: string): string[] => {
  const names: string[] = [];
  parse(doc).iterate({
    enter: (node) => {
      names.push(node.name);
    },
  });
  return names;
};

describe("mathSyntax (lezer 확장)", () => {
  it("인라인 $…$를 InlineMath로 인식", () => {
    const names = nodeNames("값은 $a^2 + b$ 이다");
    expect(names).toContain("InlineMath");
  });

  it("블록 $$…$$를 MathBlock으로 인식", () => {
    const names = nodeNames("앞 문단\n\n$$\n\\frac{1}{2}\n$$\n\n뒤 문단");
    expect(names).toContain("MathBlock");
  });

  it("한 줄 $$…$$도 MathBlock", () => {
    const names = nodeNames("$$e=mc^2$$");
    expect(names).toContain("MathBlock");
  });

  it("화폐 표기($5, $ 뒤 공백)는 수식이 아니다", () => {
    expect(nodeNames("가격은 $ 5 달러")).not.toContain("InlineMath");
    expect(nodeNames("cost $5 and $6")).not.toContain("InlineMath");
  });

  it("닫는 $ 없으면 수식이 아니다", () => {
    expect(nodeNames("열린 $x 수식")).not.toContain("InlineMath");
  });
});

describe("parseTable (GFM 표)", () => {
  it("정렬·행렬 해석", () => {
    const t = parseTable(
      [
        "| 이름 | 값 | 비고 |",
        "|:-----|:-:|--:|",
        "| a | 1 | x |",
        "| b | 2 | y |",
      ].join("\n"),
    );
    expect(t).not.toBeNull();
    expect(t!.header).toEqual(["이름", "값", "비고"]);
    expect(t!.align).toEqual(["left", "center", "right"]);
    expect(t!.rows).toEqual([
      ["a", "1", "x"],
      ["b", "2", "y"],
    ]);
  });

  it("이스케이프된 파이프와 불균형 행", () => {
    const t = parseTable("| a\\|b | c |\n|---|---|\n| x |");
    expect(t!.header).toEqual(["a|b", "c"]);
    expect(t!.rows).toEqual([["x"]]);
  });

  it("구분 줄이 없으면 표가 아니다", () => {
    expect(parseTable("| a | b |\n| 1 | 2 |")).toBeNull();
  });
});

describe("computeMatches (검색)", () => {
  const q = (text: string, o: Partial<Parameters<typeof computeMatches>[1]> = {}) => ({
    text,
    caseSensitive: false,
    regexp: false,
    replacement: "",
    ...o,
  });

  it("대소문자 무시 매칭", () => {
    expect(computeMatches("Apple apple APPLE", q("apple"))).toHaveLength(3);
  });

  it("대소문자 구분", () => {
    expect(computeMatches("Apple apple", q("apple", { caseSensitive: true }))).toHaveLength(1);
  });

  it("정규식", () => {
    expect(computeMatches("a1 b22 c333", q("\\d+", { regexp: true }))).toHaveLength(3);
  });

  it("잘못된 정규식은 빈 결과", () => {
    expect(computeMatches("abc", q("([", { regexp: true }))).toEqual([]);
  });

  it("한글 검색", () => {
    expect(computeMatches("다양한 한글 텍스트 한글", q("한글"))).toHaveLength(2);
  });
});

describe("체크박스 토글 위젯 동작", () => {
  it("원문의 [ ]/[x]를 토글하는 정규식이 목록 표시를 잡는다", () => {
    const re = /^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/;
    const m = re.exec("- [ ] 할 일")!;
    expect(m[2]).toBe(" ");
    expect("- [ ] 할 일".slice(0, m[1].length) + "x" + "- [ ] 할 일".slice(m[1].length + 1)).toBe(
      "- [x] 할 일",
    );
    expect(re.exec("  * [x] 끝")).not.toBeNull();
    expect(re.exec("일반 텍스트 [ ] 아님")).toBeNull();
    expect(re.exec("1. [X] 번째")).not.toBeNull();
  });
});

describe("EditorView + 라이브 프리뷰 장식(통합)", () => {
  it("위젯 장식이 실제 DOM에 붙는다", async () => {
    const view = new EditorView({
      state: createDocState("# 제목\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", "edit"),
      parent: document.body,
    });
    // 초기 장식은 뷰 구축 뒤 마이크로태스크로 반영된다.
    await new Promise((r) => setTimeout(r, 20));
    const table = document.querySelector(".md-table");
    expect(table).not.toBeNull();
    view.destroy();
  });
});
