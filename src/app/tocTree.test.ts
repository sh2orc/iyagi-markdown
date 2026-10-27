// 목차 트리 — 수준 관계·접기·조상 경로·필터의 순수 단위 테스트.

import { describe, expect, it } from "vitest";

import { ancestorSlugs, duplicateHeadings, filterHeadings, headingPath, tocTree, visibleNodes } from "./tocTree";
import { collectHeadings, type Heading } from "../links";

const H = (level: number, text: string, i: number): Heading => ({
  level,
  text,
  slug: `${text}-${i}`,
  pos: i * 10,
});

describe("tocTree", () => {
  it("부모-자식 관계와 하위 수", () => {
    const hs = [H(1, "개요", 0), H(2, "배경", 1), H(2, "방법", 2), H(3, "실험", 3), H(1, "결론", 4)];
    const roots = tocTree(hs);
    expect(roots.map((r) => r.heading.text)).toEqual(["개요", "결론"]);
    const gae = roots[0]!;
    expect(gae.descendantCount).toBe(3); // 배경·방법·실험
    expect(gae.children.map((c) => c.heading.text)).toEqual(["배경", "방법"]);
    expect(gae.children[1]!.children[0]!.heading.text).toBe("실험");
    expect(gae.children[1]!.descendantCount).toBe(1);
  });

  it("중간 수준 생략(h1→h3)은 표시 깊이를 당긴다", () => {
    const hs = [H(1, "시작", 0), H(3, "깊은", 1)];
    const roots = tocTree(hs);
    expect(roots[0]!.children[0]!.heading.text).toBe("깊은");
    expect(roots[0]!.children[0]!.depth).toBe(1); // depth 2가 아니라 1
  });

  it("동일 수준 연속은 형제", () => {
    const hs = [H(2, "a", 0), H(2, "b", 1)];
    const roots = tocTree(hs);
    expect(roots).toHaveLength(2);
    expect(roots[0]!.children).toHaveLength(0);
  });
});

describe("visibleNodes", () => {
  const hs = [H(1, "A", 0), H(2, "A1", 1), H(2, "A2", 2), H(1, "B", 3)];

  it("접기 없음 — 전체 평면 순서", () => {
    const names = visibleNodes(tocTree(hs), new Set()).map((n) => n.heading.text);
    expect(names).toEqual(["A", "A1", "A2", "B"]);
  });

  it("A를 접으면 하위 숨김", () => {
    const names = visibleNodes(tocTree(hs), new Set(["A-0"])).map((n) => n.heading.text);
    expect(names).toEqual(["A", "B"]);
  });
});

describe("ancestorSlugs", () => {
  it("활성 항목의 조상 경로", () => {
    const hs = [H(1, "A", 0), H(2, "A1", 1), H(3, "A1a", 2), H(1, "B", 3)];
    const anc = ancestorSlugs(tocTree(hs), "A1a-2");
    expect(anc.has("A-0")).toBe(true);
    expect(anc.has("A1-1")).toBe(true);
    expect(anc.has("A1a-2")).toBe(false); // 자기 자신 아님
    expect(anc.has("B-3")).toBe(false);
  });
});

describe("filterHeadings", () => {
  const hs = [H(1, "설치 가이드", 0), H(2, "환경", 1), H(2, "설치 오류", 2)];

  it("빈 쿼리는 null(필터 아님)·부분 일치는 대소문자 무시", () => {
    expect(filterHeadings(hs, "  ")).toBeNull();
    expect(filterHeadings(hs, "설치")!.map((h) => h.text)).toEqual(["설치 가이드", "설치 오류"]);
    expect(filterHeadings(hs, "GUIDE")).toEqual([]);
    expect(filterHeadings([{ ...hs[0]!, text: "Guide" }], "GUIDE")!.length).toBe(1);
  });

  it("매치 없음은 빈 배열", () => {
    expect(filterHeadings(hs, "없는것")).toEqual([]);
  });

  it("조합형·완성형 한글 제목과 검색어를 같은 문자열로 찾는다", () => {
    expect(filterHeadings(hs, "설치".normalize("NFD"))).toEqual([hs[0], hs[2]]);
    const decomposed = { ...hs[0], text: hs[0].text.normalize("NFD") };
    expect(filterHeadings([decomposed], "설치")).toEqual([decomposed]);
  });
});

describe("headingPath", () => {
  const hs = [
    H(1, "개요", 0),   // pos 0
    H(2, "배경", 1),   // pos 10
    H(3, "실험", 2),   // pos 20
    H(1, "결론", 3),   // pos 30
  ];

  it("깊은 위치 — 조상 체인 전체", () => {
    expect(headingPath(hs, 25).map((h) => h.text)).toEqual(["개요", "배경", "실험"]);
  });

  it("형제로 이동하면 이전 분기는 사라진다", () => {
    expect(headingPath(hs, 35).map((h) => h.text)).toEqual(["결론"]);
  });

  it("첫 제목 앞·빈 문서는 빈 경로", () => {
    // pos가 정확히 제목 위치면 포함(제목 줄에 커서)
    expect(headingPath(hs, 0).map((h) => h.text)).toEqual(["개요"]);
    expect(headingPath([], 5)).toEqual([]);
  });
});

describe("duplicateHeadings", () => {
  it("실제 수집기가 중복 접미사를 붙인 제목도 발견한다", () => {
    const text = "# 제목\n\n## 제목\n\n# 제목\n";
    expect(duplicateHeadings(collectHeadings(text))).toEqual([{ text: "제목", pos: text.indexOf("## 제목") }]);
  });
  it("같은 텍스트 제목 두 번째 등장부터 수집", () => {
    // H 헬퍼는 slug에 인덱스를 붙이므로 슬러그 동일 케이스는 직접构造.
    const mk = (text: string, slug: string, pos: number): Heading => ({ level: 1, text, slug, pos });
    const d = duplicateHeadings([mk("개요", "개요", 0), mk("다른", "다른", 5), mk("개요", "개요", 20)]);
    expect(d).toEqual([{ text: "개요", pos: 20 }]);
  });

  it("고유하면 빈 배열", () => {
    expect(duplicateHeadings([H(1, "a", 0), H(2, "b", 5)])).toEqual([]);
  });
});
