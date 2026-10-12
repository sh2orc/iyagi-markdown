// 프론트매터 단위 테스트 — 문법 노드 범위·스트립·표시용 파싱의 정확성.
// 문서 시작 인식 규칙이 핵심(첫 줄 ---만, 닫는 --- 뒤 문서 보존).

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";

import { frontMatterSyntax, frontMatterLen, parseFrontMatter, stripFrontMatter } from "./frontmatter";
import { mathSyntax } from "./mathSyntax";

const parse = (doc: string) => {
  const state = EditorState.create({
    doc,
    extensions: [
      markdown({ base: markdownLanguage, extensions: [GFM, mathSyntax, frontMatterSyntax], codeLanguages: languages, addKeymap: false }),
    ],
  });
  ensureSyntaxTree(state, doc.length + 100, 1000);
  return syntaxTree(state);
};

const DOC = `---
title: 메모
tags:
  - work
  - urgent
date: 2026-10-12
---

# 본문 제목

내용입니다.
`;

describe("frontMatterSyntax", () => {
  it("문서 시작 --- … --- 를 하나의 FrontMatter 블록으로", () => {
    const tree = parse(DOC);
    const first = tree.topNode.firstChild;
    expect(first?.name).toBe("FrontMatter");
    // 닫는 --- 까지 포함(그 뒤 개행은 제외)
    expect(DOC.slice(first!.from, first!.to).endsWith("---")).toBe(true);
    expect(first!.to).toBe(DOC.indexOf("\n\n# 본문") + 1);
    // 그 뒤 문서는 그대로(ATXHeading이 살아 있다)
    expect(first?.nextSibling?.name).toBe("ATXHeading1");
  });

  it("첫 줄이 --- 가 아니면 프론트매터가 아니다", () => {
    const doc = "# 제목\n\n---\n\ntitle: x\n";
    const tree = parse(doc);
    expect(tree.topNode.firstChild?.name).toBe("ATXHeading1");
  });
});

describe("stripFrontMatter / frontMatterLen", () => {
  it("프론트매터만 떼고 본문은 무손실", () => {
    expect(stripFrontMatter(DOC)).toBe("\n# 본문 제목\n\n내용입니다.\n");
    expect(frontMatterLen(DOC)).toBe(DOC.indexOf("\n\n# 본문") + 1);
  });

  it("없으면 원문 그대로, 길이 0", () => {
    const no = "# 그냥 문서\n";
    expect(stripFrontMatter(no)).toBe(no);
    expect(frontMatterLen(no)).toBe(0);
  });

  it("CRLF도 인식", () => {
    const crlf = "---\r\ntitle: x\r\n---\r\n본문\r\n";
    expect(stripFrontMatter(crlf)).toBe("본문\r\n");
  });
});

describe("parseFrontMatter", () => {
  it("스칼라·목록·인용부 제거", () => {
    const yaml = DOC.slice(4, DOC.indexOf("\n\n# 본문") - 3); // --- 사이 본문
    const rows = parseFrontMatter(yaml);
    expect(rows).toEqual([
      ["title", "메모"],
      ["tags", "work · urgent"],
      ["date", "2026-10-12"],
    ]);
  });

  it("키 없는 줄은 빈 키로", () => {
    expect(parseFrontMatter("그냥 줄")).toEqual([["", "그냥 줄"]]);
  });
});
