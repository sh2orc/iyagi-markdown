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
import { computeMatches, updateMatchesForChanges } from "../search/searchCm";
import { createDocState, headingFoldOf, listItemFoldOf } from "./cm";

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

describe("updateMatchesForChanges (편집 증분 매치)", () => {
  const q = (text: string, o: Partial<Parameters<typeof computeMatches>[1]> = {}) => ({
    text,
    caseSensitive: false,
    regexp: false,
    replacement: "",
    ...o,
  });

  /** 초기 문서에서 매치를 잡고 edits를 순서대로 적용한 뒤 증분 결과가
   *  전체 재스캔과 동일한지 비교한다(정합성 오라클). */
  const steps = (initial: string, needle: string, edits: Array<{ from: number; to?: number; insert: string }>) => {
    let state = EditorState.create({ doc: initial });
    let matches = computeMatches(initial, q(needle));
    for (const e of edits) {
      const tr = state.update({ changes: { from: e.from, to: e.to ?? e.from, insert: e.insert } });
      matches = updateMatchesForChanges(matches, tr.changes, tr.state.doc, q(needle));
      state = tr.state;
    }
    return { matches, expected: computeMatches(state.doc.toString(), q(needle)), doc: state.doc.toString() };
  };

  it("삽입이 경계 걸침 매치를 만든다", () => {
    const r = steps("ap ap", "apple", [{ from: 2, insert: "ple" }]);
    expect(r.matches).toEqual(r.expected);
    expect(r.doc).toBe("apple ap");
  });

  it("삭제가 매치를 파괴한다", () => {
    const r = steps("apple app", "apple", [{ from: 0, to: 3, insert: "" }]);
    expect(r.matches).toEqual(r.expected); // "le app" — 매치 없음
    expect(r.matches).toHaveLength(0);
  });

  it("매치 내부 교체는 그 매치만 없앤다", () => {
    const r = steps("apple apple", "apple", [{ from: 1, to: 2, insert: "x" }]);
    expect(r.matches).toEqual(r.expected); // "axple apple" — 뒤 매치만
    expect(r.matches).toHaveLength(1);
  });

  it("매치 경계 밖 삽입은 기존 매치를 시프트만", () => {
    const r = steps("apple XX apple", "apple", [{ from: 5, insert: "YY" }]);
    expect(r.matches).toEqual(r.expected);
    expect(r.matches.map((m) => m.from)).toEqual([0, 11]);
  });

  it("매치 시작/끝 경계의 삽입은 흡수하지 않는다", () => {
    const r = steps("apple apple", "apple", [{ from: 5, insert: "|" }, { from: 12, insert: "|" }]);
    expect(r.matches).toEqual(r.expected);
  });

  it("여러 매치를 건드리는 대체", () => {
    const r = steps("ab ab ab", "ab", [{ from: 3, to: 5, insert: "ab ab" }]);
    expect(r.matches).toEqual(r.expected);
  });

  it("대소문자 무시 증분", () => {
    const r = steps("Apple apple", "apple", [{ from: 0, to: 5, insert: "APPLE" }]);
    expect(r.matches).toEqual(r.expected);
  });

  it("연속 편집 시퀀스(무작위) — 전체 재스캔과 항상 동일", () => {
    let s = 12345;
    const rand = (n: number) => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let trial = 0; trial < 120; trial++) {
      const needle = trial % 2 === 0 ? "one" : "two";
      const initial = "one two one two one two three";
      const edits: Array<{ from: number; to?: number; insert: string }> = [];
      let len = initial.length;
      for (let i = 0; i < 10; i++) {
        const from = rand(len);
        const to = Math.min(len, from + rand(6));
        edits.push({ from, to, insert: ["one ", "x", "", "two", "o", "two one"][rand(6)] });
        len += edits[edits.length - 1].insert.length - (to - from);
      }
      const r = steps(initial, needle, edits);
      expect(r.matches).toEqual(r.expected);
    }
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

describe("서식 복사 프리워머", () => {
  it("prewarmCopyRenderer는 인스턴스를 만든다(비동기)", async () => {
    // 지연 청크 로드 — vitest node 환경에서도 동작하는지 확인.
    const { __testingCopy } = await import("./cm");
    await __testingCopy.prewarm();
    expect(__testingCopy.ready()).toBe(true);
  });
});

describe("하이라이트 문법 (lezer 확장)", () => {
  it("==텍스트== 를 Highlight로, 여는 == 뒤 공백은 아님", () => {
    const names = nodeNames("==강조== 끝");
    expect(names).toContain("Highlight");
    const no = nodeNames("== 공백==");
    expect(no).not.toContain("Highlight");
  });

  it("줄을 넘거나 닫힘이 없으면 하이라이트가 아니다", () => {
    expect(nodeNames("==열기만")).not.toContain("Highlight");
  });
});

describe("각주 정의 블록 (lezer 확장)", () => {
  it("[^label]: 줄을 FootnoteDef로, 이어 다른 블록 보존", () => {
    const names = nodeNames("[^a]: 정의 내용\n\n# 다음 제목\n");
    expect(names).toContain("FootnoteDef");
    expect(names).toContain("ATXHeading1");
  });

  it("콜론 없는 [^label] 참조는 정의가 아니다(문단 안 인라인)", () => {
    const names = nodeNames("각주 참조 [^a] 여기\n");
    expect(names).not.toContain("FootnoteDef");
    expect(names).toContain("FootnoteRef");
  });
});

describe("각주 정의 여러 줄", () => {
  it("4칸 들여쓰기 연속 줄을 포함, 빈 줄 뒤 문서 보존", () => {
    const doc = "[^a]: 첫 줄\n    이어지는 설명\n    더 이어짐\n\n뒤 문단.\n";
    const names = nodeNames(doc);
    expect(names).toContain("FootnoteDef");
    expect(names).toContain("Paragraph");
    // 정의 범위가 연속 줄까지 — 상태로 직접 확인
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM, mathSyntax], codeLanguages: languages, addKeymap: false })],
    });
    ensureSyntaxTree(state, doc.length + 100, 1000);
    let def: { from: number; to: number } | null = null;
    syntaxTree(state).iterate({ enter: (n) => { if (n.name === "FootnoteDef") def = { from: n.from, to: n.to }; } });
    expect(def!.to).toBe(doc.indexOf("\n\n뒤 문단"));
  });

  it("들여쓰기 없는 다음 줄은 정의가 아니다(브레이커 보존)", () => {
    const doc = "[^a]: 정의\n# 바로 제목\n";
    const names = nodeNames(doc);
    expect(names).toContain("FootnoteDef");
    expect(names).toContain("ATXHeading1");
  });
});

describe("제목 접기 (foldService)", () => {
  it("헤딩은 다음 같거나 낮은 단계 제목 전까지 접힌다", () => {
    const doc = "# A\n\n본문\n\n## B1\n\n내용\n\n## B2\n\n끝\n";
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM, mathSyntax], codeLanguages: languages, addKeymap: false })],
    });
    ensureSyntaxTree(state, doc.length + 100, 1000);
    // foldService는 언어 데이터로 등록되므로 실제 등록 경로(cm) 대신
    // 순수 범위 계산만 검증한다 — cm.headingFoldOf 헬퍼로 노출.
    // h1은 다음 h1까지 — 없으면 문서 끝. from은 제목 줄 끝.
    expect(headingFoldOf(state, 0)).toEqual({ from: 3, to: doc.trimEnd().length + 1 });
    // h2는 다음 같은 단계(h2) 전까지.
    expect(headingFoldOf(state, doc.indexOf("## B1"))).toEqual({
      from: doc.indexOf("## B1") + 5,
      to: doc.indexOf("## B2") - 1,
    });
    expect(headingFoldOf(state, doc.indexOf("본문"))).toBeNull(); // 제목 아님
  });
});

describe("목록 항목 접기", () => {
  it("마커 줄에서 항목 전체(하위 포함)까지", () => {
    const doc = "- 항목 A\n  - 하위\n    - 더 하위\n- 항목 B\n";
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM, mathSyntax], codeLanguages: languages, addKeymap: false })],
    });
    ensureSyntaxTree(state, doc.length + 100, 5000);
    const first = listItemFoldOf(state, 0);
    expect(first).toEqual({ from: 6, to: doc.indexOf("- 항목 B") - 1 }); // 줄 끝(6)
    expect(listItemFoldOf(state, doc.indexOf("- 항목 B"))).toBeNull(); // 하위 없음 → 접히지 않음
    expect(listItemFoldOf(state, doc.indexOf("항목 A"))).toBeNull(); // 줄 시작 아님
  });
});

// — 링크 편집(findLinkAt의 텍스트·URL 추출) —
describe("findLinkAt", async () => {
  const { findLinkAt } = await import("./livePreview");
  const { EditorState } = await import("@codemirror/state");
  const { markdown, markdownLanguage } = await import("@codemirror/lang-markdown");
  const { GFM } = await import("@lezer/markdown");
  const { ensureSyntaxTree } = await import("@codemirror/language");
  const { mathSyntax } = await import("./mathSyntax");

  const stateOf = (doc: string) => {
    const st = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [GFM, mathSyntax], addKeymap: false })],
    });
    ensureSyntaxTree(st, doc.length + 100, 5000);
    return st;
  };

  it("표시 텍스트와 URL, 범위를 정확히", () => {
    const doc = "앞 [사이트](https://x.y/z?a=1) 뒤";
    const at = doc.indexOf("사이트");
    const link = findLinkAt(stateOf(doc), at);
    expect(link?.text).toBe("사이트");
    expect(link?.url).toBe("https://x.y/z?a=1");
    expect(doc.slice(link!.from, link!.to)).toBe("[사이트](https://x.y/z?a=1)");
  });

  it("URL에 <꺾쇠>가 있으면 벗겨낸다", () => {
    const doc = "[문서](<my file.md>)";
    const link = findLinkAt(stateOf(doc), 1);
    expect(link?.url).toBe("my file.md");
    expect(link?.text).toBe("문서");
  });

  it("링크 밖이면 null", () => {
    const doc = "[링크](https://x) 그냥 텍스트";
    expect(findLinkAt(stateOf(doc), doc.indexOf("그냥"))).toBeNull();
  });
});
