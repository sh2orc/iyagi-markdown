// 스마트 문장부호 — 문맥 판정의 순수 단위 테스트(입력 확장의 회귀 방지).

import { describe, expect, it } from "vitest";

import { isCloseQuote, smartChar } from "./smartPunct";

describe("isCloseQuote", () => {
  it("앞이 없거나 공백·여는 괄호·따옴표면 여는 쪽(false)", () => {
    expect(isCloseQuote("")).toBe(false);
    expect(isCloseQuote("단어 ")).toBe(false);
    expect(isCloseQuote("(")).toBe(false);
    expect(isCloseQuote("[ ")).toBe(false);
    expect(isCloseQuote("“")).toBe(false);
  });

  it("앞이 글자·숫자·닫는 괄호·문장부호면 닫는 쪽(true)", () => {
    expect(isCloseQuote("단어")).toBe(true);
    expect(isCloseQuote("word")).toBe(true);
    expect(isCloseQuote(")")).toBe(true);
    expect(isCloseQuote(",")).toBe(true);
  });
});

describe("smartChar", () => {
  it('쌍따옴표: 문맥에 따라 “ / ”', () => {
    expect(smartChar('"', "그는 ")).toEqual([0, "“"]);
    expect(smartChar('"', "안녕")).toEqual([0, "”"]);
    expect(smartChar('"', "")).toEqual([0, "“"]);
  });

  it("홑따옴표: ‘ / ’", () => {
    expect(smartChar("'", "it ")).toEqual([0, "‘"]);
    expect(smartChar("'", "don")).toEqual([0, "’"]);
  });

  it("세 점 → …", () => {
    expect(smartChar(".", "뭐..")).toEqual([-2, "…"]);
    expect(smartChar(".", "뭐.")).toBeNull(); // 두 점 아님
    expect(smartChar(".", "뭐...")).toBeNull(); // 이미 세 점 이상(네 번째)
  });

  it("두 대시 → – , –- → —", () => {
    expect(smartChar("-", "12--")).toEqual([-2, "–"]);
    expect(smartChar("-", "–")).toEqual([-1, "—"]);
    expect(smartChar("-", "--")).toBeNull(); // 줄 시작(앞 글자 없음)
    expect(smartChar("-", "1---")).toBeNull(); // 대시 3연속(hr 보호)
  });

  it("변환 대상 외는 null", () => {
    expect(smartChar("a", "x")).toBeNull();
    expect(smartChar(" ", "x")).toBeNull();
  });
});
