// 인용·서지 순수 로직 — 정의 파싱·첫 등장 순 번호·표시 문자열·HTML 치환.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { citeDefsToHtml, citeDisplay, citeNumbering, isCiteDefLine } from "./citations";

const DOC = [
  "서론 [@kim2020]와 연구 [@lee2021, p. 12].",
  "",
  "```",
  "[@fence]: 펜스 안은 무시",
  "```",
  "",
  "[@kim2020]: Kim, S. (2020). *첫 연구*. 출판사.",
  "[@lee2021]: Lee, J. (2021). 두 번째.",
].join("\n");

describe("parseCiteDefs · citeNumbering", () => {
  it("정의 파싱(펜스 제외)·줄 번호", () => {
    const { defs } = citeNumbering(DOC);
    expect(defs.size).toBe(2);
    expect(defs.get("kim2020")?.line).toBe(7);
    expect(defs.get("kim2020")?.entry).toBe("Kim, S. (2020). *첫 연구*. 출판사.");
    expect(defs.has("fence")).toBe(false);
  });

  it("첫 등장 순 번호 — 인용 안 달린 정의는 번호 없음", () => {
    const n = citeNumbering(DOC + "\n[@unused]: 달리지 않음.");
    expect(n.order).toEqual(["kim2020", "lee2021"]); // 출현(본문 인용)만 순서에
    expect(n.num.get("kim2020")).toBe(1);
    expect(n.num.get("lee2021")).toBe(2);
    expect(n.num.has("unused")).toBe(false);
  });

  it("정의 줄 안의 [@..]는 출현으로 세지 않는다", () => {
    const n = citeNumbering("본문 [@a].\n\n[@a]: A [@b] 안쪽.\n[@b]: B.");
    expect(n.order).toEqual(["a"]);
  });
});

describe("citeDisplay · isCiteDefLine", () => {
  const n = citeNumbering(DOC);
  it("번호·접미사 표시", () => {
    expect(citeDisplay("kim2020", undefined, n)).toBe("[1]");
    expect(citeDisplay("lee2021", "p. 12", n)).toBe("[2, p. 12]");
    expect(citeDisplay("nope", undefined, n)).toBeNull();
  });
  it("정의 줄 판정", () => {
    expect(isCiteDefLine("[@a]: x")).toBe(true);
    expect(isCiteDefLine("  [@a]: x")).toBe(true);
    expect(isCiteDefLine("[@a] 본문")).toBe(false);
    expect(isCiteDefLine("```")).toBe(false);
  });
});

describe("citeDefsToHtml (내보내기 전처리)", () => {
  it("정의 줄 → 서지 문단(번호·앵커), 펜스·본문 보존", () => {
    const n = citeNumbering(DOC);
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const html = citeDefsToHtml(DOC, n, esc);
    expect(html).toContain('<p class="ref-entry" id="ref-kim2020"><span class="ref-num">[1]</span> Kim, S. (2020). *첫 연구*. 출판사.</p>');
    expect(html).toContain('id="ref-lee2021"');
    expect(html).toContain("[@fence]: 펜스 안은 무시");
    expect(html).toContain("서론 [@kim2020]와");
  });
  it("인용 안 달린 정의는 번호 없이", () => {
    const src = "[@u]: U.";
    const html = citeDefsToHtml(src, citeNumbering(src), (s) => s);
    expect(html).not.toContain("ref-num");
  });
});
