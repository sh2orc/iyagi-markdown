// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { acceptCompletion, currentCompletions, hasNextSnippetField, insertCompletionText, nextSnippetField, setSelectedCompletion,
  startCompletion, type CompletionContext, type CompletionResult, type CompletionSource,
} from "@codemirror/autocomplete";
import { wikiAutocompletion } from "./wikiComplete";

const js = javascript();
const views: EditorView[] = [];
function mount(body: string, extra: Extension = []) {
  const doc = `\`\`\`js\n${body}\n\`\`\``;
  const pos = doc.lastIndexOf("\n");
  const view = new EditorView({ parent: document.body, state: EditorState.create({
    doc, selection: { anchor: pos }, extensions: [
      markdown({ base: markdownLanguage, codeLanguages: (info) => info === "js" ? js.language : null }),
      js.support, wikiAutocompletion(), extra,
    ],
  }) });
  views.push(view);
  ensureSyntaxTree(view.state, view.state.doc.length, 1000);
  return view;
}
const labels = (view: EditorView) => currentCompletions(view.state).map((option) => option.label);
async function open(view: EditorView) {
  startCompletion(view);
  await vi.advanceTimersByTimeAsync(250);
}
function choose(view: EditorView, label: string) {
  const index = labels(view).indexOf(label);
  expect(index).toBeGreaterThanOrEqual(0);
  view.dispatch({ effects: setSelectedCompletion(index) });
  expect(acceptCompletion(view)).toBe(true);
}
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.clearAllTimers(); vi.useRealTimers();
});

it("배열 후보도 JavaScript 키워드·지역 변수와 함께 표시하고 적용한다", async () => {
  vi.useFakeTimers();
  const view = mount("const consumer = 1;\ncons", js.language.data.of({
    autocomplete: ["constellation", { label: "consult", apply: "consult()" }],
  }));
  await open(view);
  expect(labels(view)).toEqual(expect.arrayContaining(["const", "consumer", "constellation", "consult"]));
  choose(view, "consult");
  expect(view.state.doc.toString()).toBe("```js\nconst consumer = 1;\nconsult()\n```");
});

it("기본 언어 스니펫의 자리표시자 선택과 다음 필드 이동을 유지한다", async () => {
  vi.useFakeTimers();
  const view = mount("fun");
  await open(view);
  choose(view, "function");
  expect(view.state.doc.line(2).text).toBe("function name(params) {");
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("name");
  expect(hasNextSnippetField(view.state)).toBe(true);
  expect(nextSnippetField(view)).toBe(true);
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("params");
});

it("느린 소스를 기다리는 동안 기본 후보를 보여 주고 도착한 결과를 함께 표시한다", async () => {
  vi.useFakeTimers();
  let resolve!: (result: CompletionResult) => void;
  const slow: CompletionSource = (context) => new Promise((done) => {
    resolve = (result) => done(result);
    expect(context.pos).toBe(context.state.doc.line(2).to);
  });
  const view = mount("cons", js.language.data.of({ autocomplete: slow }));
  await open(view);
  expect(labels(view)).toContain("const");
  expect(labels(view)).not.toContain("consumerRemote");
  resolve({ from: view.state.doc.line(2).from, options: [{ label: "consumerRemote" }] });
  await vi.advanceTimersByTimeAsync(100);
  expect(labels(view)).toEqual(expect.arrayContaining(["const", "consumerRemote"]));
  choose(view, "consumerRemote");
  expect(view.state.doc.line(2).text).toBe("consumerRemote");
});

it("서로 다른 교체 범위를 가진 소스의 적용 계약을 유지한다", async () => {
  vi.useFakeTimers();
  const short: CompletionSource = (context) => ({ from: context.pos - 3, options: [{ label: "console" }] });
  const whole: CompletionSource = (context) => ({ from: context.state.doc.lineAt(context.pos).from,
    filter: false, options: [{ label: "Replace expression", apply: "replacement()" }],
  });
  for (const label of ["console", "Replace expression"]) {
    const view = mount("prefix.con", [
      js.language.data.of({ autocomplete: short }), js.language.data.of({ autocomplete: whole }),
    ]);
    await open(view);
    expect(labels(view)).toEqual(expect.arrayContaining(["console", "Replace expression"]));
    choose(view, label);
    expect(view.state.doc.line(2).text).toBe(label === "console" ? "prefix.console" : "replacement()");
  }
});

it("커서를 옮기면 비동기 소스에 취소를 전달하고 늦은 결과를 표시하지 않는다", async () => {
  vi.useFakeTimers();
  let pending!: CompletionContext;
  let resolve!: (result: CompletionResult) => void;
  const aborted = vi.fn();
  const slow: CompletionSource = (context) => {
    pending = context;
    context.addEventListener("abort", aborted);
    return new Promise((done) => { resolve = (result) => done(result); });
  };
  const view = mount("cons", js.language.data.of({ autocomplete: slow }));
  await open(view);
  view.dispatch({ selection: { anchor: 0 } });
  expect(aborted).toHaveBeenCalledOnce();
  expect(pending.aborted).toBe(true);
  resolve({ from: 6, options: [{ label: "consumerLate" }] });
  await vi.advanceTimersByTimeAsync(100);
  expect(currentCompletions(view.state)).toEqual([]);
  expect(view.state.doc.line(2).text).toBe("cons");
});

it("후보 표시 뒤 잠긴 문서는 키보드와 직접 적용 경로 모두 편집하지 않는다", async () => {
  vi.useFakeTimers();
  const lock = new Compartment();
  const view = mount("cons", [lock.of(EditorState.readOnly.of(false)),
    js.language.data.of({ autocomplete: ["consumer"] }),
  ]);
  await open(view);
  const index = labels(view).indexOf("consumer");
  expect(index).toBeGreaterThanOrEqual(0);
  view.dispatch({ effects: setSelectedCompletion(index) });
  view.dispatch({ effects: lock.reconfigure(EditorState.readOnly.of(true)) });
  const before = view.state.doc;
  expect(acceptCompletion(view)).toBe(false);
  // The native pointer path uses this transaction rather than acceptCompletion.
  view.dispatch(insertCompletionText(view.state, "consumer", view.state.doc.line(2).from, view.state.doc.line(2).to));
  expect(view.state.doc).toBe(before);
});
