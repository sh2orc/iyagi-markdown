// 링크 해석·슬러그 — crates/md-core/src/links.rs의 테스트 벡터와 같은 사례로
// 양쪽 구현이 일치하는지 잡는다(앵커 이동·내부 열기 정확성).

import { describe, expect, it } from "vitest";

import { collectHeadings, lexicallyClean, percentDecode, resolveLink, slugifyHeading, tocMarkdown } from "./links";

const base = "/Users/x/docs";

describe("resolveLink", () => {
  it("외부 URL과 메일", () => {
    expect(resolveLink("https://example.com/a?b=1", base)).toEqual({
      kind: "external",
      url: "https://example.com/a?b=1",
    });
    expect(resolveLink("mailto:a@b.c", base).kind).toBe("mail");
  });

  it("앵커만", () => {
    expect(resolveLink("#개요", base)).toEqual({ kind: "anchor", id: "개요" });
    expect(resolveLink("#section-2", base)).toEqual({ kind: "anchor", id: "section-2" });
  });

  it("상대 마크다운 링크", () => {
    expect(resolveLink("notes/today.md", base)).toEqual({
      kind: "markdown",
      path: "/Users/x/docs/notes/today.md",
      anchor: null,
    });
    expect(resolveLink("./up/../a.md#head", base)).toEqual({
      kind: "markdown",
      path: "/Users/x/docs/a.md",
      anchor: "head",
    });
    expect(resolveLink("b.MARKDOWN", base)).toEqual({
      kind: "markdown",
      path: "/Users/x/docs/b.MARKDOWN",
      anchor: null,
    });
  });

  it("퍼센트 인코딩 경로", () => {
    expect(resolveLink("my%20file.md", base)).toEqual({
      kind: "markdown",
      path: "/Users/x/docs/my file.md",
      anchor: null,
    });
    expect(resolveLink("img/_%EC%82%AC%EC%A7%84.png", base)).toEqual({
      kind: "asset",
      path: "/Users/x/docs/img/_사진.png",
    });
  });

  it("자원과 기타 스킴", () => {
    expect(resolveLink("media/diagram.svg", base)).toEqual({
      kind: "asset",
      path: "/Users/x/docs/media/diagram.svg",
    });
    expect(resolveLink("file:///tmp/a.md", base).kind).toBe("other");
  });
});

describe("slugifyHeading (Rust slug_heading과 동일 규칙)", () => {
  it("GitHub 방식", () => {
    expect(slugifyHeading("Hello, World!")).toBe("hello-world");
    expect(slugifyHeading("한글 제목 이해")).toBe("한글-제목-이해");
    expect(slugifyHeading("C++ & Rust")).toBe("c-rust");
    expect(slugifyHeading("  ---  ")).toBe("section");
    expect(slugifyHeading("Multiple   Spaces")).toBe("multiple-spaces");
  });
});

describe("collectHeadings", () => {
  it("코드 블록 안의 # 은 무시하고 중복 슬러그에 -1을 붙인다", () => {
    const md = [
      "# 소개",
      "",
      "```",
      "# not a heading",
      "```",
      "",
      "## 소개", // 중복 → 소개-1
      "",
      "text",
      "### 실제 ## 제목 ###", // 끝 마무리 # 제거
      "",
      "setext 밑줄", // (setext는 수집 안 함 — ATX만)
      "===",
    ].join("\n");
    const heads = collectHeadings(md);
    expect(heads.map((h) => `${h.level}:${h.slug}:${h.text}`)).toEqual([
      "1:소개:소개",
      "2:소개-1:소개",
      "3:실제-제목:실제 ## 제목",
    ]);
  });

  it("빈 제목 슬러그는 section", () => {
    expect(collectHeadings("# !!!\n")[0].slug).toBe("section");
  });
});

describe("percentDecode·lexicallyClean", () => {
  it("잘못된 이스케이프는 그대로", () => {
    expect(percentDecode("100%")).toBe("100%");
    expect(percentDecode("a%2Gb")).toBe("a%2Gb");
    expect(percentDecode("%41%42")).toBe("AB");
  });
  it("경로 정리", () => {
    expect(lexicallyClean("/a/./b/../c")).toBe("/a/c");
    expect(lexicallyClean("a/b/../../c")).toBe("c");
  });
});

describe("tocMarkdown", () => {
  it("단계별 들여쓰기·슬러그 앵커 목차", () => {
    const hs = collectHeadings("# 개요\n\n## 설치\n\n### macOS\n");
    expect(tocMarkdown(hs)).toBe(
      "- [개요](#개요)\n  - [설치](#설치)\n    - [macOS](#macos)",
    );
  });

  it("h2 뿌리 문서·중복 슬러그·빈 목차", () => {
    const hs = collectHeadings("## 가\n\n## 가\n");
    expect(tocMarkdown(hs)).toBe("- [가](#가)\n- [가](#가-1)");
    expect(tocMarkdown([])).toBe("");
  });
});
