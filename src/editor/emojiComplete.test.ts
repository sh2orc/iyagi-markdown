// 이모지 자동완성 단위 테스트 — ":쿼리" 매칭·가드(시각·URL·한글 콜론).
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { emojiCompletions } from "./emojiComplete";

const viewOf = (doc: string): EditorView =>
  new EditorView({ state: EditorState.create({ doc, extensions: [] }), parent: document.body });

const ctxAt = (view: EditorView): CompletionContext =>
  new CompletionContext(view.state, view.state.doc.length, false, view);

const applies = (doc: string): string[] => {
  const view = viewOf(doc);
  const result = emojiCompletions(ctxAt(view));
  const out = result ? result.options.map((o) => String(o.apply)) : null;
  view.destroy();
  return out ?? [];
};

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

  it("from — 콜론 다음 문자부터 교체 범위", () => {
    const view = viewOf("메모 :fire");
    const result = emojiCompletions(ctxAt(view));
    expect(result?.from).toBe("메모 :".length);
    expect(result?.options.length).toBeGreaterThan(0);
    view.destroy();
  });
});
