// 위키링크 단위 테스트 — 문법 노드·이름 분해·인덱스 해석·내보내기 변환.
// 같은 디렉터리 우선 규칙이 열기 정확성의 핵심.

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";

import { wikiLinkSyntax, parseWikiLink, buildWikiIndex, resolveWikiLink, wikiLinksToMarkdown } from "./wiki";
import { mathSyntax } from "./mathSyntax";
import type { TreeNode } from "../api";

const parse = (doc: string) => {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [GFM, mathSyntax, wikiLinkSyntax], codeLanguages: languages, addKeymap: false }),
    ],
  });
  ensureSyntaxTree(state, doc.length + 100, 1000);
  return syntaxTree(state);
};

describe("wikiLinkSyntax", () => {
  it("[[이름]]을 WikiLink로, 한 겝 [x]는 그냥 둔다", () => {
    const tree = parse("메모 [[노트]] 링크 [일반](x.md)\n");
    const names: string[] = [];
    tree.iterate({ enter: (n) => { names.push(n.name); } });
    expect(names).toContain("WikiLink");
    // 정확한 범위
    const t2 = parse("[[노트]] 끝");
    let found: { from: number; to: number } | null = null;
    t2.iterate({ enter: (n) => { if (n.name === "WikiLink") found = { from: n.from, to: n.to }; } });
    expect(found).toEqual({ from: 0, to: 6 });
  });

  it("닫는 ]가 한 개면 위키링크가 아니다", () => {
    const tree = parse("[노트] 흉내\n");
    const names: string[] = [];
    tree.iterate({ enter: (n) => { names.push(n.name); } });
    expect(names).not.toContain("WikiLink");
  });
});

describe("parseWikiLink", () => {
  it("이름·앵커·표시 분해", () => {
    expect(parseWikiLink("[[노트]]")).toEqual({ name: "노트", anchor: null, display: null });
    expect(parseWikiLink("[[folder/노트#제목|보여줄 것]]")).toEqual({
      name: "folder/노트",
      anchor: "제목",
      display: "보여줄 것",
    });
    expect(parseWikiLink("[[a\\b]]").name).toBe("a/b");
  });
});

const tree: TreeNode[] = [
  {
    kind: "dir",
    name: "notes",
    path: "/w/notes",
    children: [{ kind: "file", name: "memo.md", path: "/w/notes/memo.md", stem: "memo" }],
  },
  { kind: "file", name: "Memo.MD", path: "/w/Memo.MD", stem: "Memo" },
  { kind: "file", name: "다른.md", path: "/w/다른.md", stem: "다른" },
];

describe("buildWikiIndex / resolveWikiLink", () => {
  const idx = buildWikiIndex(tree);

  it("stem 일치(대소문자무시)·같은 디렉터리 우선", () => {
    expect(resolveWikiLink("memo", "/w/notes", idx)).toBe("/w/notes/memo.md");
    expect(resolveWikiLink("MEMO", "/elsewhere", idx)).toBe("/w/notes/memo.md"); // 도달 순 첫 번째
    expect(resolveWikiLink("notes/memo", "/", idx)).toBe("/w/notes/memo.md");
    expect(resolveWikiLink("없는문서", "/w", idx)).toBeNull();
  });
});

describe("wikiLinksToMarkdown", () => {
  const resolve = (name: string) => (name === "다른" ? "/w/sub/다른.md" : null);

  it("해석되면 상대 링크, 아니면 이름.md — 표시·앵커 반영", () => {
    expect(wikiLinksToMarkdown("see [[다른]] now", resolve, "/w")).toBe("see [다른](sub/다른.md) now");
    expect(wikiLinksToMarkdown("[[memo|메모]]", resolve, "/w")).toBe("[메모](memo.md)");
    expect(wikiLinksToMarkdown("[[memo#결론]]", resolve, "/w")).toBe("[memo](memo.md#결론)");
  });

  it("블록 참조(^)와 빈 이름은 그대로", () => {
    expect(wikiLinksToMarkdown("[[^블록]]", resolve, "/w")).toBe("[[^블록]]");
  });
});

describe("명시적인 루트 파일 경로 위키링크", () => {
  it("동명 문서와 다른 확장자를 분리한다", () => {
    const index = buildWikiIndex([
      { kind: "file", name: "memo.md", stem: "memo", path: "/w/memo.md" },
      { kind: "file", name: "memo.markdown", stem: "memo", path: "/w/memo.markdown" },
      { kind: "dir", name: "notes", path: "/w/notes", children: [
        { kind: "file", name: "memo.md", stem: "memo", path: "/w/notes/memo.md" },
      ] },
    ]);
    expect(resolveWikiLink("/memo.markdown", "/w/notes", index)).toBe("/w/memo.markdown");
    expect(resolveWikiLink("/notes/memo.md", "/w", index)).toBe("/w/notes/memo.md");
    expect(resolveWikiLink("memo", "/w/notes", index)).toBe("/w/notes/memo.md");
  });
});
