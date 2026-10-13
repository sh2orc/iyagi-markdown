// 섹션 이동 계산 — 범위·무효 이동·삭제 보정의 순수 단위 테스트.

import { describe, expect, it } from "vitest";

import { moveSection, sectionRange, trimSectionForMove } from "./sectionMove";
import type { Heading } from "../links";

const H = (level: number, text: string, pos: number): Heading => ({
  level,
  text,
  slug: text,
  pos,
});

// 문서: "# A … # B … ## B1 … # C" — 줄 단위 대략 위치.
const DOC = "# A\n내용A\n\n# B\n내용B\n\n## B1\n내용B1\n\n# C\n내용C\n";
const POS = (needle: string): number => DOC.indexOf(needle);
const HS: Heading[] = [
  H(1, "A", POS("# A")),
  H(1, "B", POS("# B")),
  H(2, "B1", POS("## B1")),
  H(1, "C", POS("# C")),
];

describe("sectionRange", () => {
  it("다음 동급/상위 제목 전까지", () => {
    expect(sectionRange(HS, 0, DOC.length)).toEqual({ from: POS("# A"), to: POS("# B") });
    expect(sectionRange(HS, 1, DOC.length)).toEqual({ from: POS("# B"), to: POS("# C") }); // 하위 B1 포함
    expect(sectionRange(HS, 3, DOC.length)).toEqual({ from: POS("# C"), to: DOC.length });
  });
});

describe("moveSection", () => {
  it("앞으로 이동 — 삽입 위치 그대로", () => {
    const m = moveSection(HS, 1, 0, DOC.length); // B 섹션를 A 앞으로
    expect(m).toEqual({
      from: POS("# B"),
      to: POS("# C"),
      insertAt: POS("# A"),
      cursor: POS("# A"),
    });
  });

  it("뒤로 이동 — 삭제 길이만큼 삽입 위치 보정", () => {
    const m = moveSection(HS, 0, 3, DOC.length); // A 섹션를 C 앞으로
    const aLen = POS("# B") - POS("# A");
    expect(m?.insertAt).toBe(POS("# C") - aLen);
  });

  it("자기 내부·같은 항목은 무효(null)", () => {
    expect(moveSection(HS, 1, 1, DOC.length)).toBeNull();
    expect(moveSection(HS, 1, 2, DOC.length)).toBeNull(); // B 섹션 안의 B1 앞
  });
});

describe("trimSectionForMove", () => {
  it("끝 공백 잘라 이동 잔여 없게", () => {
    expect(trimSectionForMove("# B\n내용\n\n\n")).toEqual({
      text: "# B\n내용",
      cut: 3,
    });
    expect(trimSectionForMove("# B\n내용").cut).toBe(0);
  });
});
