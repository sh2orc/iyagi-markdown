// 인용 자동완성 단위 테스트 — "[@위치"에서 문서 내 서지 키 후보.
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { autocompletion, CompletionContext, currentCompletions, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { frontMatterSyntax } from "./frontmatter";
import { mathSyntax } from "./mathSyntax";
import { wikiLinkSyntax } from "./wiki";
import { citeCompletions } from "./citeComplete";

import { combinedMatcher } from "./wikiComplete";

const stateOf = (doc: string): EditorState => EditorState.create({ doc, extensions: [history(), markdown({
  base: markdownLanguage, extensions: [frontMatterSyntax, mathSyntax, wikiLinkSyntax],
})] });

function result(view: EditorView, pos: number) {
  ensureSyntaxTree(view.state, view.state.doc.length, 1000);
  return citeCompletions(new CompletionContext(view.state, pos, false, view));
}

function apply(view: EditorView, r: CompletionResult, pos: number, label = "smith") {
  const option = r.options.find((item) => item.label === label)!;
  if (typeof option.apply !== "function") throw new Error("Expected guarded citation completion");
  option.apply(view, option, r.from, pos);
}

const resultAt = (doc: string, pos: number) => {
  const state = stateOf(doc);
  const view = new EditorView({ state, parent: document.body });
  ensureSyntaxTree(state, state.doc.length, 1000);
  const r = combinedMatcher(new CompletionContext(state, pos, false, view));
  view.destroy();
  return r;
};

describe("인용 자동완성", () => {
  it("'[@sm' → 정의된 서지 키 후보(닫는 ] 포함 적용)", () => {
    const doc = "연구 [@sm 인용\n\n[@smith]: Smith, J. (2020). *Title*.\n[@lee]: Lee (2021). *다른 책*.\n";
    const r = resultAt(doc, 7); // "[@sm" 직후(연구=0,1 / 공백 2 / [=3 @=4 s=5 m=6)
    expect(r).not.toBeNull();
    expect(r!.options.map((o) => o.label)).toContain("smith");
    expect(r!.from).toBe(3); // 여는 [@까지 한 번에 교체
    expect(r!.options.length).toBe(1); // "lee"는 "sm"과 불일치
  });

  it("빈 쿼리 '[@' → 정의된 키 전체, 미정의 키는 없음", () => {
    const doc = "가 [@ 했고 [@kim]도 인용\n\n[@real]: Real (2020).\n";
    const r = resultAt(doc, 4); // "[@" 직후(가=0, 공백 1, [=2, @=3)
    expect(r).not.toBeNull();
    const labels = r!.options.map((o) => o.label);
    expect(labels).toContain("real");
    expect(labels).not.toContain("kim"); // kim은 인용됐지만 정의 없음
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

  it.each([
    ["See [@sm] after", "See [@smith] after"],
    ["See [@smi,  p. 12–14 ] after", "See [@smith,  p. 12–14 ] after"],
    ["See [@sm after", "See [@smith] after"],
    ["See [@sm, p. 12", "See [@smith, p. 12"],
  ])("괄호 중복 없이 키를 교체하고 페이지 표기를 보존한다: %s", (source, expected) => {
    const bibliography = "\n\n[@smith]: Smith, J. *Title*.";
    const view = new EditorView({ state: stateOf(source + bibliography), parent: document.body });
    const pos = source.indexOf("[@") + 4;
    try {
      const r = result(view, pos)!;
      expect(r.options[0].detail).toBe("Smith, J. *Title*.");
      apply(view, r, pos);
      expect(view.state.doc.toString()).toBe(expected + bibliography);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source + bibliography);
    } finally { view.destroy(); }
  });

  it("페이지 표기 입력 중에는 서지 키 후보를 띄우지 않는다", () => {
    const source = "[@smith, p. 12]\n\n[@smith]: S.";
    expect(resultAt(source, source.indexOf("12") + 2)).toBeNull();
  });

  it.each(["`[@sm`", "```\n[@sm\n```", "---\ntitle: '[@sm'\n---", "$x [@sm$", "\\[@sm", "[label [@sm]](target)", "[@sm](target)", "[[note|[@sm]]]"])("보호된 문맥의 인용 표기에서는 제안하지 않는다: %s", (source) => {
    expect(resultAt(`${source}\n\n[@smith]: S.`, source.indexOf("[@sm") + 4)).toBeNull();
  });

  it("서지 정의의 키를 사용처로 바꾸지 않고 쉼표가 든 정의 키를 제안하지 않는다", () => {
    expect(resultAt("[@smith]: S.\n\n[@smaller]: Small.", 4)).toBeNull();
    const r = resultAt("[@\n\n[@valid]: V.\n[@bad,key]: Bad.", 2)!;
    expect(r.options.map((item) => item.label)).toEqual(["valid"]);
  });

  it("문서의 서지 항목이 바뀌면 후보와 설명을 갱신한다", () => {
    const source = "[@\n\n[@smith]: Old entry.";
    const view = new EditorView({ state: stateOf(source), parent: document.body });
    try {
      const previous = result(view, 2)!;
      view.dispatch({ changes: { from: source.indexOf("\n\n"), to: source.length,
        insert: "\n\n[@lee]: New entry.",
      } });
      const next = previous.update!(previous, previous.from, 2, new CompletionContext(view.state, 2, false, view))!;
      expect(next.options.map(({ label, detail }) => ({ label, detail }))).toEqual([
        { label: "lee", detail: "New entry." },
      ]);
      expect(previous.options.map((item) => item.label)).toEqual(["smith"]);
    } finally { view.destroy(); }
  });

  it.each(["removed", "readonly", "changed", "filter"])("%s 후에는 이전 후보로 인용을 넣지 않는다", (cause) => {
    const source = "[@sm\n\n[@smith]: S.";
    const view = new EditorView({ state: stateOf(source), parent: document.body });
    try {
      const r = result(view, 4)!;
      if (cause === "removed") view.dispatch({ changes: { from: source.indexOf("\n\n"), to: source.length } });
      else if (cause === "readonly") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
      else if (cause === "changed") view.dispatch({ changes: { from: 2, to: 4, insert: "zz" } });
      else view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
      const before = view.state.doc.toString();
      apply(view, r, 4);
      expect(view.state.doc.toString()).toBe(before);
    } finally { view.destroy(); }
  });

  it("실제 자동완성에서도 상한 밖 키를 검색하고 삭제하면 전체 후보로 돌아온다", async () => {
    vi.useFakeTimers();
    const definitions = Array.from({ length: 30 }, (_, i) => `[@key${i}]: Reference ${i}`).join("\n");
    const view = new EditorView({ state: stateOf(`\n\n${definitions}`), parent: document.body });
    try {
      view.dispatch({ effects: StateEffect.appendConfig.of(autocompletion({ override: [citeCompletions] })) });
      view.dispatch({ changes: { from: 0, insert: "[@key29" }, selection: { anchor: 7 }, userEvent: "input.type" });
      await vi.advanceTimersByTimeAsync(200);
      expect(currentCompletions(view.state).map((item) => item.label)).toEqual(["key29"]);
      view.dispatch({ changes: { from: 2, to: 7 }, userEvent: "delete.backward" });
      await vi.advanceTimersByTimeAsync(100);
      expect(currentCompletions(view.state)).toHaveLength(20);
      expect(currentCompletions(view.state)[0].label).toBe("key0");
    } finally { view.destroy(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
});
