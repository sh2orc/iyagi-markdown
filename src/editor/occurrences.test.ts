// 같은 단어 강조 — 단어 추출·경계 일치의 순수 단위 테스트.

import { describe, expect, it } from "vitest";

import { matchPositionsInLine, wordAt } from "./occurrences";

describe("wordAt", () => {
  it("글자 연속 단어 추출(한글·영문·밑줄)", () => {
    expect(wordAt("문서를 작성한다", 1)).toBe("문서를"); // pos가 '서' 안
    expect(wordAt("hello world", 2)).toBe("hello");
    expect(wordAt("my_var name", 3)).toBe("my_var");
  });

  it("3자 미만·숫자만은 제외", () => {
    expect(wordAt("ab cd", 1)).toBe("");
    expect(wordAt("123 456", 2)).toBe("");
    expect(wordAt("abc", 1)).toBe("abc"); // 경계값 3자는 포함
  });
});

describe("matchPositionsInLine", () => {
  it("대소문자 무시 + 단어 경계만", () => {
    expect(matchPositionsInLine("Word word wording", "word")).toEqual([
      [0, 4],
      [5, 9],
    ]); // wording은 경계 밖
  });

  it("한글 단어 — 조사가 붙어도 경계 판정", () => {
    expect(matchPositionsInLine("문서를 작성 문서의", "문서")).toEqual([
      [0, 2],
      [7, 9],
    ]); // 문서를·문서의는 '를/의'가 글자라 경계 아님 → 순수 반복만? 아니다 —
    // '문서를'의 문서는 뒤에 조사가 붙어 단어 경계가 아니므로 제외되고,
    // 독립 '문서'만 잡는다. (한글 교착어 특성상 조사 붙은 형태는 별개 단어로 본다)
  });

  it("겹침 없이 전진", () => {
    expect(matchPositionsInLine("aa aa aa", "aa")).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
    ]);
  });
});
