// 서식 복사(Format Painter) — 서식 판독의 순수 단위 테스트(마커 삽입 적용의 회귀 방지).

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { ensureSyntaxTree } from "@codemirror/language";

import { mathSyntax } from "./mathSyntax";
import { copyFormat, formatAt, marksAt, pasteFormat, resetPainted } from "./formatPainter";

function stateOf(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM, mathSyntax], addKeymap: false })],
  });
  ensureSyntaxTree(state, doc.length + 100, 5000);
  return state;
}

/** 문서에서 마커 위치 — 정확한 오프셋 산출용. */
function posOf(doc: string, needle: string): number {
  return doc.indexOf(needle);
}

describe("marksAt", () => {
  it("굵게+기울임 중첩 안의 위치는 둘 다 감지", () => {
    const doc = "앞 ***둘다*** 뒤";
    const inner = posOf(doc, "둘다") + 1;
    const marks = marksAt(stateOf(doc), inner);
    expect(marks).toContain("strong");
    expect(marks).toContain("em");
  });

  it("코드·취소선·하이라이트 각각 감지, 본문은 빈 집합", () => {
    expect(marksAt(stateOf("`x` 외부"), 1)).toContain("code");
    expect(marksAt(stateOf("~~삭~~"), 2)).toContain("strike");
    expect(marksAt(stateOf("==빛=="), 2)).toContain("highlight");
    expect(marksAt(stateOf("평범한 본문"), 3)).toEqual([]);
  });
});

describe("formatAt", () => {
  it("제목 수준·인용 감지", () => {
    expect(formatAt(stateOf("### 제목"), 4).heading).toBe(3);
    expect(formatAt(stateOf("> 인용문"), 3).quote).toBe(true);
    expect(formatAt(stateOf("본문"), 1).heading).toBe(0);
  });
});

describe("copyFormat/pasteFormat", () => {
  function mount(doc: string): EditorView {
    const host = document.createElement("div");
    document.body.append(host);
    return new EditorView({ state: stateOf(doc), parent: host });
  }

  it("중첩 서식(굵게+기울임)을 복사해 평문에 붙이면 ***로 감싸진다", () => {
    resetPainted();
    const src = mount("***둘다***");
    src.dispatch({ selection: { anchor: 4 } }); // 중첩 안쪽
    copyFormat(src);
    const dst = mount("대상 텍스트");
    dst.dispatch({ selection: { anchor: 0, head: dst.state.doc.length } });
    pasteFormat(dst);
    expect(dst.state.doc.toString()).toBe("***대상 텍스트***");
    src.destroy();
    dst.destroy();
  });

  it("복사된 적 없으면 붙여넣기 false", () => {
    resetPainted();
    const v = mount("텍스트");
    expect(pasteFormat(v)).toBe(false);
    v.destroy();
  });

  it("이미 같은 서식이면 덧씌우지 않는다(set 의미론)", () => {
    const src = mount("**굵게**");
    copyFormat(src);
    const dst = mount("**이미 굵게**");
    dst.dispatch({ selection: { anchor: 2, head: dst.state.doc.length - 2 } });
    pasteFormat(dst);
    expect(dst.state.doc.toString()).toBe("**이미 굵게**"); // 변화 없음
    src.destroy();
    dst.destroy();
  });
});
