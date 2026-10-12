// 태그 추출·색인 — 순수 로직 검증.

import { describe, expect, it } from "vitest";

import { extractTags, buildTagIndex } from "./tags";

describe("extractTags", () => {
  it("본문 태그 인식 — 위치 포함", () => {
    const tags = extractTags("회의 #중요 메모 #프로젝트/마케팅 끝\n");
    expect(tags.map((t) => t.tag)).toEqual(["프로젝트/마케팅", "중요"].sort((a, b) => a.localeCompare(b)));
    expect(tags[0]?.positions.length).toBe(1);
  });

  it("제목의 #은 태그가 아니다", () => {
    expect(extractTags("# 제목\n## 소제목\n")).toEqual([]);
  });

  it("줄 시작·공백 뒤만 — 붙어 있으면 무시", () => {
    expect(extractTags("value#태그\n")).toEqual([]);
    expect(extractTags("#태그 시작\n")).toEqual([{ tag: "태그", positions: [0] }]);
  });

  it("숫자 시작 태그 제외·코드펜스 제외", () => {
    expect(extractTags("이슈 #123 아님 #v2 는 태그\n")).toEqual([{ tag: "v2", positions: [11] }]);
    expect(extractTags("```\n#코드안\n```\n")).toEqual([]);
  });

  it("중복 태그 위치 누적", () => {
    const tags = extractTags("#a 와 #a\n또 #a\n");
    expect(tags).toEqual([{ tag: "a", positions: [0, 5, 10] }]);
  });

  it("빈 문서·태그 없음", () => {
    expect(extractTags("")).toEqual([]);
    expect(extractTags("그냥 텍스트\n")).toEqual([]);
  });
});

describe("buildTagIndex", () => {
  it("문서별 태그 → 태그별 문서", () => {
    const idx = buildTagIndex([
      { path: "/a.md", tags: ["x", "y"] },
      { path: "/b.md", tags: ["x"] },
    ]);
    expect(idx.find((e) => e.tag === "x")?.paths).toEqual(["/a.md", "/b.md"]);
    expect(idx.find((e) => e.tag === "y")?.paths).toEqual(["/a.md"]);
    // 많이 쓰인 태그 먼저.
    expect(idx[0]?.tag).toBe("x");
  });
});
