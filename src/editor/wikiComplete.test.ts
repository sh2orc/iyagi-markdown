// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { CompletionContext, currentCompletions, type CompletionResult } from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { combinedMatcher, setWikiDocsProvider, setTagListProvider, wikiAutocompletion } from "./wikiComplete";
import { wikiLinkSyntax, parseWikiLink, buildWikiIndex, resolveWikiLink } from "./wiki";
import { frontMatterSyntax } from "./frontmatter";
import { mathSyntax } from "./mathSyntax";
import { previewConfigField, setPreviewConfig } from "./livePreview";
import { workspaceCompletions } from "../app/workspaceCompletions";
import { inlineLinkParts } from "./inlineLinkEdit";
import { resolveLink } from "../links";
import type { TreeNode } from "../api";

const views: EditorView[] = [];
function mount(doc: string) {
  const host = document.createElement("div"); document.body.append(host);
  const view = new EditorView({ parent: host, state: EditorState.create({ doc, extensions: [
    history(), previewConfigField,
    markdown({ base: markdownLanguage, extensions: [wikiLinkSyntax, frontMatterSyntax, mathSyntax] }),
  ] }) });
  views.push(view);
  view.dispatch({ effects: setPreviewConfig.of({ ...view.state.field(previewConfigField), baseDir: "/w" }) });
  return view;
}
function result(view: EditorView, pos = view.state.doc.length) {
  ensureSyntaxTree(view.state, view.state.doc.length, 1000);
  return combinedMatcher(new CompletionContext(view.state, pos, false, view));
}
function apply(view: EditorView, r: CompletionResult, pos: number, optionIndex = 0) {
  const option = r.options[optionIndex];
  if (typeof option.apply !== "function") throw new Error("Expected guarded completion");
  option.apply(view, option, r.from, pos);
}
afterEach(() => {
  for (const view of views.splice(0)) { const host = view.dom.parentElement; view.destroy(); host?.remove(); }
  setWikiDocsProvider(null); setTagListProvider(null); vi.clearAllTimers(); vi.useRealTimers();
});

it("동명 후보의 표시명이 같아도 선택한 경로로 연결하고 한 번에 실행 취소한다", () => {
  const tree: TreeNode[] = [{ kind: "file", name: "memo.md", stem: "memo", path: "/w/memo.md" },
    { kind: "dir", name: "sub", path: "/w/sub", children: [
      { kind: "file", name: "memo.md", stem: "memo", path: "/w/sub/memo.md" },
    ] }];
  setWikiDocsProvider(() => workspaceCompletions(tree).docs);
  const view = mount("[[mem"), r = result(view)!;
  apply(view, r, 5, 1);
  expect(view.state.doc.toString()).toBe("[[/sub/memo.md]]");
  expect(resolveWikiLink(parseWikiLink(view.state.doc.toString()).name, "/w", buildWikiIndex(tree))).toBe("/w/sub/memo.md");
  expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe("[[mem");
});

it.each(["[[mem]] tail", "[[mem#Heading|Label]] tail", "[[mem] tail"])("기존 닫힘·앵커·별칭을 보존한다: %s", (source) => {
  setWikiDocsProvider(() => [{ name: "memo", path: "/w/memo.md", target: "memo" }]);
  const view = mount(source), r = result(view, 4)!;
  apply(view, r, 4);
  expect(view.state.doc.toString()).toBe(source.includes("#") ? "[[memo#Heading|Label]] tail" : "[[memo]] tail");
});

it("위키로 표현할 수 없는 파일명은 인코딩한 Markdown 링크로 연결한다", () => {
  const tree: TreeNode[] = [{ kind: "file", name: "a#b [1].md", path: "/w/a#b [1].md" }];
  setWikiDocsProvider(() => workspaceCompletions(tree).docs);
  const view = mount("[[a"), r = result(view)!;
  apply(view, r, 3);
  const link = inlineLinkParts(view.state.doc.toString())!;
  expect(link.text).toBe("a#b [1]");
  expect(resolveLink(link.url, "/w")).toEqual({ kind: "markdown", path: "/w/a#b [1].md", anchor: null });
});

it("실제 매처로 한글 서브시퀀스·보조 평면 문자와 지우기 후 후보 복원을 처리한다", () => {
  setWikiDocsProvider(() => [
    { name: "노트/마케팅", path: "/w/marketing.md" }, { name: "😀 회의록", path: "/w/meeting.md" },
  ]);
  expect(result(mount("[[노트마"))!.options.map((o) => o.label)).toEqual(["노트/마케팅"]);
  expect(result(mount("[[😀"))!.options.map((o) => o.label)).toEqual(["😀 회의록"]);
  const view = mount("[[노트마"), narrowed = result(view)!;
  view.dispatch({ changes: { from: 2, to: view.state.doc.length } });
  const updated = narrowed.update!(narrowed, 0, 2, new CompletionContext(view.state, 2, false, view));
  expect(updated!.options).toHaveLength(2);
});

it("제거된 문서 후보·잠긴 문서에는 적용하지 않는다", () => {
  const docs = [{ name: "memo", path: "/w/memo.md" }];
  setWikiDocsProvider(() => docs);
  const view = mount("[[me"), r = result(view)!;
  setWikiDocsProvider(() => []); apply(view, r, 4);
  expect(view.state.doc.toString()).toBe("[[me");
  setWikiDocsProvider(() => docs);
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  apply(view, r, 4); expect(view.state.doc.toString()).toBe("[[me");
  expect(result(view)).toBeNull();
});

it.each(["`[[me`", "```\n[[me\n```", "---\ntitle: [[me\n---", "$x [[me$", "\\[[me"])("리터럴·이스케이프 입력에는 위키 후보가 없다: %s", (source) => {
  setWikiDocsProvider(() => [{ name: "memo", path: "/w/memo.md" }]);
  expect(result(mount(source), source.indexOf("[[me") + 4)).toBeNull();
});

it("미완성 위키 경로 속 슬래시는 블록 명령으로 바뀌지 않는다", () => {
  expect(result(mount("[[folder /h1"))).toBeNull();
});

it("태그는 단어·URL 경계를 침범하지 않고 기존 토큰을 한 번만 완성한다", () => {
  setTagListProvider(() => ["project"]);
  for (const source of ["word#pro", "https://site/#pro", "#１２", "# "]) expect(result(mount(source))).toBeNull();
  const view = mount("#proJECT tail"), r = result(view, 4)!;
  apply(view, r, 4); expect(view.state.doc.toString()).toBe("#project tail");
});

it("자동완성 엔진에서도 30개 제한 밖 문서를 검색하고 지우면 후보가 복원된다", async () => {
  vi.useFakeTimers();
  setWikiDocsProvider(() => Array.from({ length: 40 }, (_, i) => ({ name: `note${i}`, path: `/w/note${i}.md` })));
  const view = mount("");
  view.dispatch({ effects: StateEffect.appendConfig.of(wikiAutocompletion()) });
  view.dispatch({ changes: { from: 0, insert: "[[note39" }, selection: { anchor: 8 }, userEvent: "input.type" });
  await vi.advanceTimersByTimeAsync(200);
  expect(currentCompletions(view.state).map((o) => o.label)).toEqual(["note39"]);
  view.dispatch({ changes: { from: 2, to: 8 }, userEvent: "delete.backward" });
  await vi.advanceTimersByTimeAsync(100);
  expect(currentCompletions(view.state)).toHaveLength(30);
});
