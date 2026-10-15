// 코드펜스 언어·중첩 코드 완성 단위 테스트 — override 체인 복원 검증.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";

import { combinedMatcher } from "./wikiComplete";

const stateOf = (doc: string): EditorState =>
  EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [GFM], codeLanguages: languages, addKeymap: false }),
    ],
  });

const resultAt = (doc: string, pos: number) => {
  const state = stateOf(doc);
  const view = new EditorView({ state, parent: document.body });
  const r = combinedMatcher(new CompletionContext(state, pos, false, view));
  view.destroy();
  return r;
};

describe("펜스 언어 자동완성", { retry: 1 }, () => {
  it("'```py' → Python 후보", () => {
    const r = resultAt("```py\n", 5);
    expect(r).not.toBeNull();
    const labels = r!.options.map((o) => String(o.apply ?? o.label));
    expect(labels).toContain("Python");
  });

  it("'```ru' → Ruby/Rust 정확한 접두 매칭", () => {
    const r = resultAt("```ru\n", 5);
    const labels = r!.options.map((o) => String(o.apply ?? o.label));
    expect(labels).toContain("Rust");
    expect(labels).toContain("Ruby");
  });

  it("본문 텍스트에서는 언어 완성 없음", () => {
    expect(resultAt("일반 텍스트 py\n", 9)).toBeNull();
  });
});

describe("중첩 코드 완성(언어 데이터 소스 복원)", { retry: 1 }, () => {
  it("js 펜스 안 'cons' → const/console 등 키워드", () => {
    const doc = "```js\ncons\n```\n";
    const r = resultAt(doc, 9); // 'cons' 끝
    expect(r).not.toBeNull();
    const labels = r!.options.map((o) => String(o.label));
    expect(labels.some((l) => /const|console/.test(l))).toBe(true);
  });
});
