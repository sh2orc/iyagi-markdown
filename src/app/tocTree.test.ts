// 목차 트리 — 수준 관계·접기·조상 경로·필터의 순수 단위 테스트.

import { describe, expect, it } from "vitest";

import { ancestorSlugs, filterHeadings, tocTree, visibleNodes } from "./tocTree";
import type { Heading } from "../links";

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
    expect(filterHeadings(hs, "GUIDE")).toBeNull;
    expect(filterHeadings([{ ...hs[0]!, text: "Guide" }], "GUIDE")!.length).toBe(1);
  });

  it("매치 없음은 빈 배열", () => {
    expect(filterHeadings(hs, "없는것")).toEqual([]);
  });
});
