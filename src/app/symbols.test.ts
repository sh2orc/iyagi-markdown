// 특수 문자 기호표 — 검색·분류 필터의 순수 단위 테스트.

import { describe, expect, it } from "vitest";

import { SYMBOLS, searchSymbols } from "./symbols";

describe("searchSymbols", () => {
  it("이름 부분 일치(한글·영문 대소문자 무시)", () => {
    expect(searchSymbols("화살표").every((s) => s.cat === "arrow")).toBe(true);
    expect(searchSymbols("ARROW").length).toBeGreaterThan(0);
    expect(searchSymbols("원 won").map((s) => s.ch)).toContain("₩");
  });

  it("문자 자체로도 찾는다", () => {
    expect(searchSymbols("±").map((s) => s.ch)).toEqual(["±"]);
    expect(searchSymbols("…").map((s) => s.ch)).toEqual(["…"]);
  });

  it("분류 필터 — 카테고리 안에서만", () => {
    const math = searchSymbols("", "math");
    expect(math.length).toBeGreaterThan(0);
    expect(math.every((s) => s.cat === "math")).toBe(true);
  });

  it("빈 쿼리는 전체·이상한 검색은 빈 배열", () => {
    expect(searchSymbols("")).toEqual(SYMBOLS);
    expect(searchSymbols("zzz없는기호")).toEqual([]);
  });

  it("기호는 중복 없음(키 안전)", () => {
    const set = new Set(SYMBOLS.map((s) => `${s.ch}-${s.name}`));
    expect(set.size).toBe(SYMBOLS.length);
  });
});
