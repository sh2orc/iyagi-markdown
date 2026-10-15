// 서식 기호(¶) 위치 계산 — 순수 함수.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { formattingMarkRanges } from "./fmMarks";

describe("formattingMarkRanges (서식 기호)", () => {
  it("공백·탭·줄바꿈 위치와 종류", () => {
    const marks = formattingMarkRanges("a b\tc\nd", 10);
    expect(marks).toEqual([
      { kind: "space", from: 11, to: 12 },
      { kind: "tab", from: 13, to: 14 },
      { kind: "para", from: 15 },
    ]);
  });

  it("연속 공백도 한 칸씩(중복 공백 가시화)", () => {
    const marks = formattingMarkRanges("a  b", 0);
    expect(marks.filter((m) => m.kind === "space").length).toBe(2);
    expect(marks[0]).toEqual({ kind: "space", from: 1, to: 2 });
    expect(marks[1]).toEqual({ kind: "space", from: 2, to: 3 });
  });

  it("기호 없는 텍스트는 빈 배열", () => {
    expect(formattingMarkRanges("abc", 0)).toEqual([]);
  });
});
