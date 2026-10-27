// 프론트매터 단위 테스트 — 문법 노드 범위·스트립·표시용 파싱의 정확성.
// 문서 시작 인식 규칙이 핵심(첫 줄 ---만, 닫는 --- 뒤 문서 보존).

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { languages } from "@codemirror/language-data";

import { frontMatterMeta, frontMatterSyntax, frontMatterLen, parseFrontMatter, stripFrontMatter, upsertFrontMatter } from "./frontmatter";
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

describe("frontMatterSyntax", { retry: 1 }, () => {
  it("문서 시작 --- … --- 를 하나의 FrontMatter 블록으로", () => {
    const tree = parse(DOC);
    const first = tree.topNode.firstChild;
    expect(first?.name).toBe("FrontMatter");
    // 닫는 --- 까지 포함(노드는 그 뒤 개행 직전까지 — 스트립 정규식은 개행까지)
    expect(DOC.slice(first!.from, first!.to).endsWith("---")).toBe(true);
    expect(first!.to).toBe(DOC.indexOf("\n\n# 본문"));
    // 그 뒤 문서는 그대로(ATXHeading이 살아 있다)
    expect(first?.nextSibling?.name).toBe("ATXHeading1");
  });

  it("첫 줄이 --- 가 아니면 프론트매터가 아니다", () => {
    const doc = "# 제목\n\n---\n\ntitle: x\n";
    const tree = parse(doc);
    expect(tree.topNode.firstChild?.name).toBe("ATXHeading1");
  });

  it("닫는 --- 이 없는 첫 줄 --- 는 수평선이다(2026-10-20 보고 — 문서를 통째로 삼키던 버그)", () => {
    const tree = parse("---\n본문입니다.\n");
    expect(tree.topNode.firstChild?.name).toBe("HorizontalRule");
    expect(tree.topNode.firstChild?.nextSibling?.name).toBe("Paragraph");
  });

  it("단독 --- · ---- 도 수평선", () => {
    for (const doc of ["---\n", "---", "----\n"]) {
      expect(parse(doc).topNode.firstChild?.name).toBe("HorizontalRule");
    }
  });

  it("빈 줄을 지나 닫는 --- 이 있으면 프론트매터", () => {
    const tree = parse("---\ntitle: x\n\n---\n본문\n");
    expect(tree.topNode.firstChild?.name).toBe("FrontMatter");
  });
});

describe("stripFrontMatter / frontMatterLen", { retry: 1 }, () => {
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

describe("parseFrontMatter", { retry: 1 }, () => {
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

describe("frontMatterMeta", { retry: 1 }, () => {
  it("reads export metadata beyond the preview scan limit", () => {
    const doc = `---\ndescription: ${"x".repeat(3000)}\ntitle: Long metadata\nauthor: Writer\ncover: false\n---\n# Body`;
    expect(frontMatterMeta(doc)).toMatchObject({ title: "Long metadata", author: "Writer", cover: false });
    expect(stripFrontMatter(doc)).toBe("# Body");
  });

  it("disables the EPUB cover only for explicit false values", () => {
    for (const value of ["false", "no", "0", "FALSE"]) {
      expect(frontMatterMeta(`---\ncover: ${value}\n---\n`)?.cover).toBe(false);
    }
    for (const value of ["true", "yes", "1", "unknown"]) {
      expect(frontMatterMeta(`---\ncover: ${value}\n---\n`)?.cover).toBeUndefined();
    }
  });

  it("title·author·date를 뽑는다(대소문자 무시·따옴표 제거)", () => {
    const doc = `---
title: "보고서 - 3분기"
Author: 홍길동
DATE: 2026-10-12
---

# 본문`;
    const m = frontMatterMeta(doc);
    expect(m?.title).toBe("보고서 - 3분기");
    expect(m?.author).toBe("홍길동");
    expect(m?.date).toBe("2026-10-12");
  });

  it("프론트매터가 없거나 메타가 비면 null", () => {
    expect(frontMatterMeta("# 그냥 문서")).toBeNull();
    expect(frontMatterMeta("---\nfoo: 1\n---\n본문")).toBeNull();
  });

  it("authors(복수) 키도 작가로 인식", () => {
    const m = frontMatterMeta("---\nauthors:\n  - 김작가\n  - 이작가\n---\n");
    expect(m?.author).toBe("김작가 · 이작가");
  });
});

describe("frontMatterMeta toc", { retry: 1 }, () => {
  it("toc: true/yes/1을 참으로, 그 외는 거짓·미설정", () => {
    expect(frontMatterMeta("---\ntoc: true\n---\n")?.toc).toBe(true);
    expect(frontMatterMeta("---\ntoc: yes\n---\n")?.toc).toBe(true);
    expect(frontMatterMeta("---\ntoc: 1\n---\n")?.toc).toBe(true);
    expect(frontMatterMeta("---\ntitle: 문서\ntoc: false\n---\n")?.toc).toBeUndefined();
  });
});

describe("frontMatterMeta lof/lot", () => {
  it("그림 목차·표 목차 플래그", () => {
    const m = frontMatterMeta("---\nlof: true\nlot: yes\n---\n");
    expect(m?.lof).toBe(true);
    expect(m?.lot).toBe(true);
    expect(frontMatterMeta("---\nlof: no\n---\n")?.lof).toBeUndefined();
  });
});

describe("frontMatterMeta columns(다단)", () => {
  it("1~3만 받고 그 밖은 무시", () => {
    expect(frontMatterMeta("---\ncolumns: 2\n---\n")?.columns).toBe(2);
    expect(frontMatterMeta("---\ncolumns: 3\n---\n")?.columns).toBe(3);
    expect(frontMatterMeta("---\ncolumns: 1\n---\n")?.columns).toBe(1);
    expect(frontMatterMeta("---\ncolumns: 4\n---\n")?.columns).toBeUndefined();
    expect(frontMatterMeta("---\ncolumns: 0\n---\n")?.columns).toBeUndefined();
    expect(frontMatterMeta("본문")?.columns).toBeUndefined();
  });
});

describe("frontMatterMeta header/footer(머리글·바닥글)", () => {
  it("자유 텍스트 파싱", () => {
    const m = frontMatterMeta("---\nheader: 분기 보고서\nfooter: 기밀 · 내부용\n---\n");
    expect(m?.header).toBe("분기 보고서");
    expect(m?.footer).toBe("기밀 · 내부용");
  });
});

describe("upsertFrontMatter", () => {
  it("키 갱신 — 다른 줄·순서 보존", () => {
    const doc = "---\ntitle: 옛제목\nauthor: 홍길동\n# 주석 아님 일반 줄\ntoc: false\n---\n\n본문";
    const out = upsertFrontMatter(doc, { title: "새제목", toc: true });
    expect(out).toContain('title: "새제목"');
    expect(out).toContain("author: 홍길동");
    expect(out).toContain("toc: true");
    expect(out).toContain("본문");
    expect(out.indexOf("author")).toBeLessThan(out.indexOf("toc")); // 순서 유지
  });

  it("null이면 키 삭제, 없던 키는 추가", () => {
    const doc = "---\ntitle: 제목\n---\n본문";
    const out = upsertFrontMatter(doc, { title: null, author: "이작가" });
    expect(out).not.toContain("title:");
    expect(out).toContain('author: "이작가"');
  });

  it("블록 없으면 새로 생성, 본문 무결", () => {
    const out = upsertFrontMatter("본문\n", { title: "제목", toc: true });
    expect(out).toBe('---\ntitle: "제목"\ntoc: true\n---\n\n본문\n');
  });

  it("긴 블록의 CRLF·닫는 구분선·본문·주석을 그대로 보존한다", () => {
    const untouched = `description: ${"x".repeat(3000)}\r\n# keep\r\ncustom:\r\n  nested: yes\r\n`;
    const source = `---\r\nTitle: old # title note\r\n${untouched}---\r\n# Body\r\n\r\n`;
    const next = upsertFrontMatter(source, { title: "new" });
    expect(next).toBe(`---\r\nTitle: "new" # title note\r\n${untouched}---\r\n# Body\r\n\r\n`);
    expect(stripFrontMatter(next)).toBe(stripFrontMatter(source));
  });

  it("authors 별칭·중복 키·블록 값의 이전 내용을 남기지 않는다", () => {
    const source = "---\nAuthors:\n  - A\n  - B\n# keep\nauthor: duplicate\ntitle: |\n  Old title\n  continued\nextra: untouched\n---";
    expect(upsertFrontMatter(source, { author: "Writer", title: null })).toBe(
      '---\nauthor: "Writer"\n# keep\nextra: untouched\n---',
    );
  });

  it("입력 문자열의 구분자·주석·따옴표·줄바꿈을 값으로 왕복한다", () => {
    const title = 'Title: #1 "quoted" \\ path\nnext';
    const next = upsertFrontMatter("Body\n", { title, author: "O'Neill", toc: true });
    expect(frontMatterMeta(next)).toMatchObject({ title, author: "O'Neill", toc: true });
    expect(stripFrontMatter(next)).toBe("\nBody\n");
    expect(frontMatterMeta("---\ntitle: 'Writer''s #1' # note\ntoc: true # enabled\n---\n")
      ).toMatchObject({ title: "Writer's #1", toc: true });
  });

  it("빈 블록·끝 개행 유무와 삭제만 있는 패치를 보존한다", () => {
    expect(frontMatterLen("---\n---\nBody")).toBe(8);
    expect(upsertFrontMatter("---\n---\nBody", { title: "T" })).toBe('---\ntitle: "T"\n---\nBody');
    expect(upsertFrontMatter("Body\r\n", { title: null, author: null })).toBe("Body\r\n");
    expect(upsertFrontMatter("Body\r\n", { title: "T", author: null })).toBe('---\r\ntitle: "T"\r\n---\r\n\r\nBody\r\n');
    expect(upsertFrontMatter("---\ntitle: x\n---", {})).toBe("---\ntitle: x\n---");
  });
});
