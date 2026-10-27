// 코드펜스 언어 선택과 기본 언어 자동완성의 통합.
// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { CompletionContext, currentCompletions, startCompletion, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree, LanguageDescription } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { GFM } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";
import { frontMatterSyntax } from "./frontmatter";
import { fenceLanguageCompletions } from "./fenceComplete";

import { combinedMatcher, wikiAutocompletion } from "./wikiComplete";

const js = javascript();
const stateOf = (doc: string): EditorState =>
  EditorState.create({
    doc,
    extensions: [
      history(),
      markdown({ base: markdownLanguage, extensions: [GFM, frontMatterSyntax],
        codeLanguages: (info) => /^(js|javascript)$/.test(info) ? js.language : null, addKeymap: false }),
      js.support,
    ],
  });

const resultAt = (doc: string, pos: number) => {
  const state = stateOf(doc);
  const view = new EditorView({ state, parent: document.body });
  ensureSyntaxTree(state, state.doc.length, 1000);
  const r = combinedMatcher(new CompletionContext(state, pos, false, view));
  view.destroy();
  return r;
};

const views: EditorView[] = [];
function mount(doc: string) {
  const view = new EditorView({ state: stateOf(doc), parent: document.body });
  views.push(view);
  return view;
}
function result(view: EditorView, pos: number) {
  ensureSyntaxTree(view.state, view.state.doc.length, 1000);
  return fenceLanguageCompletions(new CompletionContext(view.state, pos, false, view));
}
function apply(view: EditorView, r: CompletionResult, pos: number, label = "Python") {
  const option = r.options.find((candidate) => candidate.label === label)!;
  if (typeof option.apply !== "function") throw new Error("Expected guarded language completion");
  option.apply(view, option, r.from, pos);
}
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.clearAllTimers(); vi.useRealTimers();
});

describe("펜스 언어 자동완성", () => {
  it("'```py' → Python 후보", () => {
    const r = resultAt("```py\n", 5);
    expect(r).not.toBeNull();
    const labels = r!.options.map((o) => o.label);
    expect(labels).toContain("Python");
  });

  it("'```ru' → Ruby/Rust 정확한 접두 매칭", () => {
    const r = resultAt("```ru\n", 5);
    const labels = r!.options.map((o) => o.label);
    expect(labels).toContain("Rust");
    expect(labels).toContain("Ruby");
  });

  it("본문 텍스트에서는 언어 완성 없음", () => {
    expect(resultAt("일반 텍스트 py\n", 9)).toBeNull();
  });

  it.each(["```pyTHon title=demo", "  ````  pyTHon {#demo}", "> ~~~~ pyTHon", "- ```pyTHon"])("언어 토큰만 교체하고 펜스·메타데이터를 유지한다: %s", (source) => {
    const view = mount(source), pos = source.indexOf("pyTHon") + 2;
    apply(view, result(view, pos)!, pos);
    expect(view.state.doc.toString()).toBe(source.replace("pyTHon", "python"));
    expect(view.state.selection.main.head).toBe(source.indexOf("pyTHon") + "python".length);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("공백이 있는 언어 이름은 파서가 인식하는 별칭으로 삽입한다", () => {
    const view = mount("```comm");
    apply(view, result(view, 7)!, 7, "Common Lisp");
    expect(view.state.doc.toString()).toBe("```lisp");
    expect(LanguageDescription.matchLanguageName(languages, view.state.doc.toString().slice(3), false)?.name).toBe("Common Lisp");
  });

  it.each([3, 4, 5])("언어 앞 공백에서 선택해도 기존 토큰을 중복하지 않는다: %s", (pos) => {
    const view = mount("```  python title=demo");
    apply(view, result(view, pos)!, pos, "JavaScript");
    expect(view.state.doc.toString()).toBe("```  javascript title=demo");
  });

  it.each<[string, number]>([
    ["~~~~markdown\n```py\n~~~~", 17],
    ["```\ncode\n```", 12],
    ["    ```py", 9],
    ["---\nexample: ```py\n---", 17],
    ["```python title=py", 18],
  ])("코드 내용·닫는 펜스·메타데이터에서는 언어를 제안하지 않는다: %s", (source, pos) => {
    expect(result(mount(source), pos)).toBeNull();
  });

  it.each(["readonly", "query", "context", "filter"])("%s 변경 뒤에는 이전 언어 후보를 삽입하지 않는다", (cause) => {
    const view = mount("```py"), previous = result(view, 5)!;
    if (cause === "readonly") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    else if (cause === "query") view.dispatch({ changes: { from: 3, to: 5, insert: "ru" } });
    else if (cause === "context") view.dispatch({ changes: { from: 0, to: 3, insert: "abc" } });
    else view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
    const before = view.state.doc.toString();
    apply(view, previous, 5);
    expect(view.state.doc.toString()).toBe(before);
  });

  it("실제 자동완성에서 js 별칭을 유지하고 검색어 삭제와 상한 밖 언어 검색을 처리한다", async () => {
    vi.useFakeTimers();
    const view = mount("");
    view.dispatch({ effects: StateEffect.appendConfig.of(wikiAutocompletion()) });
    view.dispatch({ changes: { from: 0, insert: "```js" }, selection: { anchor: 5 }, userEvent: "input.type" });
    await vi.advanceTimersByTimeAsync(200);
    expect(currentCompletions(view.state).map((option) => option.label)).toContain("JavaScript");
    view.dispatch({ changes: { from: 3, to: 5 }, userEvent: "delete.backward" });
    await vi.advanceTimersByTimeAsync(100);
    expect(currentCompletions(view.state)).toHaveLength(30);
    view.dispatch({ changes: { from: 3, insert: "z80" }, selection: { anchor: 6 }, userEvent: "input.type" });
    await vi.advanceTimersByTimeAsync(200);
    expect(currentCompletions(view.state).map((option) => option.label)).toEqual(["Z80"]);
  });
});

describe("중첩 코드 완성(독립된 언어 소스)", () => {
  it("js 펜스 안에서 키워드와 문서의 변수명을 함께 제안한다", async () => {
    vi.useFakeTimers();
    const doc = "```js\nconst consumer = 1;\ncons\n```\n";
    const view = mount(doc), pos = doc.lastIndexOf("cons") + 4;
    view.dispatch({ effects: StateEffect.appendConfig.of(wikiAutocompletion()), selection: { anchor: pos } });
    ensureSyntaxTree(view.state, view.state.doc.length, 1000);
    startCompletion(view);
    await vi.advanceTimersByTimeAsync(200);
    const labels = currentCompletions(view.state).map((option) => option.label);
    expect(labels).toContain("const");
    expect(labels).toContain("consumer");
  });
});
