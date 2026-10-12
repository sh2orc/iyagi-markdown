// 집필 보조(타이프라이터·포커스) 단위 테스트 — computeDimRanges 순수 로직.
// 흐림 범위의 정확성이 포커스 모드 신뢰성의 전부(블록 경계·간격·단일 블록).

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";

import { computeDimRanges, sentenceSpans } from "./writing";
import { mathSyntax } from "./mathSyntax";

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

const DOC = `# 제목

첫 문단입니다.

\`\`\`js
const a = 1;

const b = 2;
\`\`\`

끝 문단.
`;

describe("computeDimRanges", () => {
  it("커서 문단 외 나머지 최상위 블록이 흐려진다", () => {
    const tree = parse(DOC);
    const headEnd = DOC.indexOf("제목") + 2; // ATX 제목 노드 안
    const ranges = computeDimRanges(tree, headEnd);
    expect(ranges).toHaveLength(3); // 문단1 · 펜스 · 문단2 (제목 제외)
    expect(ranges.some((r) => r.from <= headEnd && headEnd <= r.to)).toBe(false);
    const first = DOC.indexOf("첫 문단");
    expect(ranges.some((r) => r.from <= first && first < r.to)).toBe(true);
  });

  it("블록 사이 빈 줄(간격)에서는 흐림이 풀린다", () => {
    const tree = parse(DOC);
    const gap = DOC.indexOf("\n\n") + 1; // 제목과 첫 문단 사이 빈 줄
    expect(computeDimRanges(tree, gap)).toEqual([]);
  });

  it("펜스는 빈 줄이 있어도 하나의 블록이다", () => {
    const tree = parse(DOC);
    const inFence = DOC.indexOf("const b");
    const ranges = computeDimRanges(tree, inFence);
    const fence = ranges.find((r) => r.from <= inFence && inFence <= r.to);
    expect(fence).toBeUndefined(); // 커서가 펜스 안이면 펜스는 흐려지지 않는다
    const fenceStart = DOC.indexOf("```");
    const covering = ranges.find((r) => r.from <= fenceStart && fenceStart < r.to);
    // 펜스 전체가 하나의 범위로 다뤄지는지 — 다른 블록 범위가 펜스를 쪼개지 않는지
    expect(covering).toBeUndefined();
    expect(ranges.every((r) => r.to <= fenceStart || r.from >= DOC.indexOf("끝 문단"))).toBe(true);
  });

  it("블록이 하나뿐이면 흐림이 없다", () => {
    const tree = parse("문단 하나뿐인 문서\n");
    expect(computeDimRanges(tree, 0)).toEqual([]);
  });
});

describe("sentenceSpans · 문장 포커스", () => {
  it("종결부+공백에서 끊는다(연속 ?!, 전각 포함)", () => {
    // 종결부 뒤 공백까지 문장에 포함(실측 고정).
    expect(sentenceSpans("첫 문장입니다. 두 번째! 세 번째?")).toEqual([
      [0, 9],
      [9, 15],
      [15, 20],
    ]);
    expect(sentenceSpans("한 문장뿐")).toEqual([[0, 5]]);
    expect(sentenceSpans("")).toEqual([]);
  });

  it("computeDimRanges(sentence) — 활성 블록의 다른 문장도 흐려진다", () => {
    const tree = parse("첫 문장. 둘째 문장.\n\n다른 블록.\n");
    const para = tree.topNode.firstChild!;
    const mid = para.to - 3; // 둘째 문장 안
    const dims = computeDimRanges(tree, mid, true, (a, b) => DOC2.slice(a, b));
    expect(dims.some((r) => r.from === para.from && r.to < mid)).toBe(true); // 첫 문장
    expect(dims.some((r) => r.from >= para.from && r.from < mid && r.to > mid)).toBe(false); // 현재 문장은 아니라
  });
});
const DOC2 = "첫 문장. 둘째 문장.\n\n다른 블록.\n";
