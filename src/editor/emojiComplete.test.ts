// 이모지 자동완성 단위 테스트 — ":쿼리" 매칭·가드(시각·URL·한글 콜론).
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

import { emojiCompletions } from "./emojiComplete";

const viewOf = (doc: string): EditorView =>
  new EditorView({ state: EditorState.create({ doc, extensions: [history()] }), parent: document.body });

const ctxAt = (view: EditorView): CompletionContext =>
  new CompletionContext(view.state, view.state.doc.length, false, view);

const applies = (doc: string): string[] => {
  const view = viewOf(doc);
  const original = view.state;
  const result = emojiCompletions(ctxAt(view));
  try {
    return result ? result.options.map((option) => {
      view.setState(original);
      if (typeof option.apply !== "function") throw new Error("Expected guarded emoji completion");
      option.apply(view, option, result.from, original.doc.length);
      return view.state.sliceDoc(result.from);
    }) : [];
  } finally { view.destroy(); }
};

function apply(view: EditorView, result: CompletionResult, pos: number, name: string) {
  const option = result.options.find((entry) => entry.label.endsWith(` ${name}`))!;
  if (typeof option.apply !== "function") throw new Error("Expected guarded emoji completion");
  option.apply(view, option, result.from, pos);
}

describe("emojiCompletions (:자동완성)", () => {
  it("':기쁨' → 웃는 이모지 후보", () => {
    const got = applies("오늘 기분 :기쁨");
    expect(got.length).toBeGreaterThan(0);
    expect(["😀", "😃", "😄", "😅", "😆"].some((e) => got.includes(e))).toBe(true);
  });

  it("':heart' → ❤️가 startsWith 우선권한 데 앞", () => {
    const got = applies("사랑 :heart");
    expect(got).toContain("❤️");
    expect(got.indexOf("❤️")).toBeLessThan(got.indexOf("💔"));
  });

  it("':co' → 커피·나침반 등 prefix 매칭", () => {
    const got = applies(":co");
    expect(got).toContain("☕"); // coffee
    expect(got).toContain("🧭"); // compass
  });

  it("가드 — 시각·URL·프런트매터·한글 콜론 뒤에서는 무시", () => {
    expect(applies("회의 12:30")).toEqual([]);
    expect(applies("https://example.com")).toEqual([]);
    expect(applies("title: 값")).toEqual([]);
    expect(applies("예:이렇게")).toEqual([]);
  });

  it("가드 — 콜론만으로는 목록 없음, 줄 시작·공백 뒤 콜론은 동작", () => {
    expect(applies("무언가 :")).toEqual([]);
    const got = applies(":star");
    expect(got).toContain("⭐");
  });

  it("from — 시작 콜론까지 교체 범위에 포함한다", () => {
    const view = viewOf("메모 :fire");
    const result = emojiCompletions(ctxAt(view));
    expect(result?.from).toBe("메모 ".length);
    expect(result?.options.length).toBeGreaterThan(0);
    view.destroy();
  });

  it.each(["(:heart_fire:), tail", "(:heart_fire), tail"])("별칭 중간에서 완성해도 문자만 넣고 괄호·본문을 보존한다: %s", (source) => {
    const view = viewOf(source), pos = "(:heart_f".length;
    try {
      const result = emojiCompletions(new CompletionContext(view.state, pos, false, view))!;
      apply(view, result, pos, "heart_fire");
      expect(view.state.doc.toString()).toBe("(❤️‍🔥), tail");
      expect(view.state.selection.main.head).toBe("(❤️‍🔥".length);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
    } finally { view.destroy(); }
  });

  it("분해된 한글 별칭도 검색하며 정확한 숏트이름을 먼저 제안한다", () => {
    expect(applies(`:${"기쁨".normalize("NFD")}`)).toContain("😀");
    expect(applies(":heart")[0]).toBe("❤️");
  });

  it.each(["path/:co", "file\\:co", "::co", "word_:co", "word.:co", "\\:co"])("경로·이스케이프·구두점 안에서 열지 않는다: %s", (source) => {
    expect(applies(source)).toEqual([]);
  });

  it.each(["`:co`", "```\n:co\n```", "    :co", "---\ntitle: :co\n---", "$x :co$", "[label :co](target)", "[[page :co]]"])("보호된 Markdown 구문에는 제안하지 않는다: %s", (source) => {
    const state = EditorState.create({ doc: source, extensions: [markdown({
      base: markdownLanguage, extensions: [frontMatterSyntax, mathSyntax, wikiLinkSyntax],
    })] });
    ensureSyntaxTree(state, state.doc.length, 1000);
    expect(emojiCompletions(new CompletionContext(state, source.indexOf(":co") + 3, false))).toBeNull();
  });

  it.each(["readonly", "changed", "filter"])("%s 뒤에는 오래된 결과로 원문을 바꾸지 않는다", (cause) => {
    const view = viewOf(":heart"), result = emojiCompletions(ctxAt(view))!;
    try {
      if (cause === "readonly") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
      else if (cause === "changed") view.dispatch({ changes: { from: 1, to: 6, insert: "other" } });
      else view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
      const before = view.state.doc.toString();
      apply(view, result, 6, "heart");
      expect(view.state.doc.toString()).toBe(before);
    } finally { view.destroy(); }
  });

  it("실제 자동완성에서도 한글 별칭과 검색어 삭제 후 후보를 유지한다", async () => {
    vi.useFakeTimers();
    const view = viewOf("");
    try {
      view.dispatch({ effects: StateEffect.appendConfig.of(autocompletion({ override: [emojiCompletions] })) });
      view.dispatch({ changes: { from: 0, insert: ":기쁨" }, selection: { anchor: 3 }, userEvent: "input.type" });
      await vi.advanceTimersByTimeAsync(200);
      expect(currentCompletions(view.state).some((option) => option.label.startsWith("😀 "))).toBe(true);
      view.dispatch({ changes: { from: 2, to: 3 }, userEvent: "delete.backward" });
      await vi.advanceTimersByTimeAsync(100);
      expect(currentCompletions(view.state).some((option) => option.label.startsWith("🚆 "))).toBe(true); // 기차
      view.dispatch({ changes: { from: 1, to: 2 }, userEvent: "delete.backward" });
      await vi.advanceTimersByTimeAsync(100);
      expect(currentCompletions(view.state)).toHaveLength(0);
    } finally { view.destroy(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
});
