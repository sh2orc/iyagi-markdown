// 인용 자동완성 단위 테스트 — "[@위치"에서 문서 내 서지 키 후보.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { combinedMatcher } from "./wikiComplete";

const stateOf = (doc: string): EditorState => EditorState.create({ doc });

const resultAt = (doc: string, pos: number) => {
  const state = stateOf(doc);
  const view = new EditorView({ state, parent: document.body });
  const r = combinedMatcher(new CompletionContext(state, pos, false, view));
  view.destroy();
  return r;
};

describe("인용 자동완성", () => {
  it("'[@sm' → 정의된 서지 키 후보(닫는 ] 포함 적용)", () => {
    const doc = "연구 [@sm 인용\n\n[@smith]: Smith, J. (2020). *Title*.\n[@lee]: Lee (2021). *다른 책*.\n";
    const r = resultAt(doc, 7); // "[@sm" 직후(연구=0,1 / 공백 2 / [=3 @=4 s=5 m=6)
    expect(r).not.toBeNull();
    const applies = r!.options.map((o) => String(o.apply ?? o.label));
    expect(applies).toContain("smith]");
    expect(r!.from).toBe(5); // 키 시작 위치(@ 다음)
    expect(r!.options.length).toBe(1); // "lee"는 "sm"과 불일치
  });

  it("빈 쿼리 '[@' → 정의된 키 전체, 미정의 키는 없음", () => {
    const doc = "가 [@ 했고 [@kim]도 인용\n\n[@real]: Real (2020).\n";
    const r = resultAt(doc, 4); // "[@" 직후(가=0, 공백 1, [=2, @=3)
    expect(r).not.toBeNull();
    const labels = r!.options.map((o) => String(o.apply ?? o.label));
    expect(labels).toContain("real]");
    expect(labels).not.toContain("kim]"); // kim은 인용됐지만 정의 없음
  });

  it("서지 정의가 없는 문서에서는 완성 없음", () => {
    const r = resultAt("그냥 [@ty", 7); // "[@ty" 직후(길이 8)
    expect(r).toBeNull();
  });

  it("완성된 인용 안([@smith] 뒤)에서는 추가 완성 없음", () => {
    const doc = "[@smith] 뒤 커서\n\n[@smith]: S.\n";
    const r = resultAt(doc, 5); // "[@smit" 직후 — ] 닫힘 전에는 후보
    expect(r).not.toBeNull();
    const r2 = resultAt(doc, 8); // "] " 직후 — 닫는 괄호 뒤
    expect(r2).toBeNull();
  });
});
