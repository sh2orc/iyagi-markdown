// 팔레트 라벨 파싱 — 단축키 칩 분리의 순수 단위 테스트.

import { describe, expect, it } from "vitest";

import { splitKbd } from "./CommandPalette";

describe("splitKbd", () => {
  it("끝의 단축키 토큰을 분리", () => {
    expect(splitKbd("저장 ⌘S")).toEqual(["저장", "⌘S"]);
    expect(splitKbd("굵게 ⌘B")).toEqual(["굵게", "⌘B"]);
    expect(splitKbd("서식 없이 붙여넣기 ⌥⌘⇧V")).toEqual(["서식 없이 붙여넣기", "⌥⌘⇧V"]);
    expect(splitKbd("줄 이동 ⌥↑")).toEqual(["줄 이동", "⌥↑"]);
  });

  it("단축키 없으면 그대로·첫 토큰이 아니라 끝 토큰만", () => {
    expect(splitKbd("문서 통계")).toEqual(["문서 통계", null]);
    expect(splitKbd("⌘S 로 저장")).toEqual(["⌘S 로 저장", null]); // 가운데 있으면 칩 아님
  });
});
