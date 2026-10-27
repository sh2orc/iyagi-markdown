// 링크 해석·슬러그 — crates/md-core/src/links.rs의 테스트 벡터와 같은 사례로
// 양쪽 구현이 일치하는지 잡는다(앵커 이동·내부 열기 정확성).

import { describe, expect, it } from "vitest";

import { collectHeadings, createHeadingSlugger, lexicallyClean, normalizeUnderlineRules, percentDecode, resolveLink, slugifyHeading, tocMarkdown } from "./links";

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
  it("자동 접미사와 다른 제목의 slug가 충돌하지 않는다", () => {
    const slug = createHeadingSlugger();
    expect(["A", "A", "A 1", "A", "A 1", "A 1 1", "!!!", "section", "section 1"].map(slug))
      .toEqual(["a", "a-1", "a-1-1", "a-2", "a-1-2", "a-1-1-1", "section", "section-1", "section-1-1"]);
    const fresh = createHeadingSlugger();
    expect(["A 1", "A", "A"].map(fresh)).toEqual(["a-1", "a", "a-2"]);
  });
  it("GitHub 방식", () => {
    expect(slugifyHeading("Hello, World!")).toBe("hello-world");
    expect(slugifyHeading("한글 제목 이해")).toBe("한글-제목-이해");
    expect(slugifyHeading("C++ & Rust")).toBe("c-rust");
    expect(slugifyHeading("  ---  ")).toBe("section");
    expect(slugifyHeading("Multiple   Spaces")).toBe("multiple-spaces");
  });
});

describe("collectHeadings", () => {
  it("문서 내 모든 제목의 앵커가 고유하다", () => {
    const text = "# A\n\n# A\n\n# A 1\n\n> # A\n";
    const headings = collectHeadings(text);
    expect(headings.map((h) => h.slug)).toEqual(["a", "a-1", "a-1-1", "a-2"]);
    expect(new Set(headings.map((h) => h.slug)).size).toBe(headings.length);
  });
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

  it("짧은 닫기 펜스·들여쓴 코드·HTML·수식 속의 가짜 제목을 제외한다", () => {
    const text = [
      "````md", "# code", "```", "# still code", "````", "",
      "    # indented", "", "<!--", "# comment", "-->", "",
      "<script>", "# script", "</script>", "", "$$", "# math", "$$", "",
      "# actual", "",
    ].join("\n");
    expect(collectHeadings(text).map((h) => h.text)).toEqual(["actual"]);
  });

  it("빈 ATX 제목을 원래 위치로 수집한다", () => {
    const text = "😀\n\n#\n\n# > literal\n";
    const heads = collectHeadings(text);
    expect(heads.map((h) => [h.level, h.text])).toEqual([[1, ""], [1, "> literal"]]);
    expect(heads.map((h) => h.pos)).toEqual([text.indexOf("#\n"), text.indexOf("# >")]);
  });

  it("밑줄형 setext는 제목으로 수집하지 않는다(2026-10-21 방침 — 제목은 #/## 로만)", () => {
    expect(collectHeadings("위\n---\n")).toEqual([]);
    expect(collectHeadings("위\n===\n")).toEqual([]);
    expect(collectHeadings("First line\nsecond line\n===\n")).toEqual([]);
  });

  it("컨테이너 제목은 탐색하되 루트 섹션으로 이동하지 않는다", () => {
    const text = "# Root\n\n> # Quote\n> continued\n\n- # List heading\n\n# End\n";
    const heads = collectHeadings(text);
    expect(heads.map((h) => [h.text, h.movable])).toEqual([
      ["Root", true], ["Quote", false], ["List heading", false], ["End", true],
    ]);
    expect(heads[1].pos).toBe(text.indexOf("> #"));
    expect(heads[2].pos).toBe(text.indexOf("- #"));
  });
});

describe("normalizeUnderlineRules(내보내기 setext 정규화)", () => {
  it("최상위 짝에 빈 줄 — --- 와 === 모두", () => {
    expect(normalizeUnderlineRules("본문\n---\n").text).toBe("본문\n\n---\n");
    expect(normalizeUnderlineRules("본문\n===").text).toBe("본문\n\n===");
  });

  it("인용구 짝은 빈 인용 줄(>) — 인용구 구조 유지", () => {
    expect(normalizeUnderlineRules("> 인용문\n> ---\n").text).toBe("> 인용문\n>\n> ---\n");
  });

  it("코드 블록 내부는 무변화", () => {
    const t = "```\n본문\n---\n===\n```";
    expect(normalizeUnderlineRules(t).text).toBe(t);
  });

  it("이미 수평선(빈 줄 뒤 ---)·ATX 아래 --- 은 짝이 아니다 — 무변화", () => {
    for (const t of ["본문\n\n---\n", "# 제목\n---\n", "---\n시작 수평선\n"]) {
      expect(normalizeUnderlineRules(t)).toEqual({ text: t, insertLines: [] });
    }
  });

  it("여러 짝 — 내림차순 적용, insertLines는 원본 밑줄 줄 번호(1-based)", () => {
    const r = normalizeUnderlineRules("A\n---\n\nB\n---\n");
    expect(r.text).toBe("A\n\n---\n\nB\n\n---\n");
    expect(r.insertLines).toEqual([2, 5]);
  });
});

describe("percentDecode·lexicallyClean", () => {
  it("잘못된 이스케이프는 그대로", () => {
    expect(percentDecode("100%")).toBe("100%");
    expect(percentDecode("a%2Gb")).toBe("a%2Gb");
    expect(percentDecode("%41%42")).toBe("AB");
    expect(percentDecode("%FF")).toBe("�");
    expect(percentDecode("%E2%82")).toBe("�");
    expect(percentDecode("%ED%A0%80")).toBe("���");
    expect(percentDecode("%EF%BB%BF%FF")).toBe("\uFEFF�");
    expect(percentDecode("100%한글%20%FF")).toBe("100%한글 �");
    expect(resolveLink("bad%FF.md#%E2%82", base)).toEqual({
      kind: "markdown", path: `${base}/bad�.md`, anchor: "�",
    });
  });
  it("기타 URI 스킴은 로컬 파일 경로로 해석하지 않는다", () => {
    for (const link of ["javascript:note.md", "tel:123", "file:note.md", "custom+app:note.md"]) {
      expect(resolveLink(link, base)).toEqual({ kind: "other", url: link });
    }
    expect(resolveLink("./custom:note.md", base).kind).toBe("markdown");
  });
  it("경로 정리", () => {
    expect(lexicallyClean("/a/./b/../c")).toBe("/a/c");
    expect(lexicallyClean("a/b/../../c")).toBe("c");
  });
});

describe("tocMarkdown", () => {
  it("괄호가 목차 링크를 깨지 않는다", () => {
    const heads = collectHeadings("# First [link](target.md)\n");
    expect(tocMarkdown(heads)).toBe(`- [First \\[link\\](target.md)](#${heads[0].slug})`);
  });
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

describe("collectHeadings 프런트매터", () => {
  it("FM 안의 YAML 주석(#)은 제목이 아니다 — 유령 TOC 항목 방지", () => {
    const doc = "---\ntitle: 문서\n# YAML 주석은 제목이 아니어야 한다\n---\n\n# 진짜 제목\n\n본문.\n";
    const hs = collectHeadings(doc);
    expect(hs.length).toBe(1);
    expect(hs[0].text).toBe("진짜 제목");
  });

  it("FM 이후 제목의 pos는 원본 오프셋 그대로(TOC 스크롤 정확)", () => {
    const doc = "---\ntitle: t\nx: y\n---\n# 제목\n";
    const hs = collectHeadings(doc);
    expect(doc.indexOf("# 제목")).toBe(hs[0].pos);
  });

  it("닫는 --- 없으면 FM이 아니다 — # 줄은 제목으로 수집", () => {
    const hs = collectHeadings("---\n# 제목\n");
    expect(hs.length).toBe(1);
    expect(hs[0].text).toBe("제목");
  });
});
