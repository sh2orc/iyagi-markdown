// 변경 추적 — 베이스라인 diff로 바뀐 줄 계산의 순수 단위 테스트.

import { describe, expect, it } from "vitest";

import { changedLines } from "./trackChanges";
import { hunksOf } from "../components/TrackPanel";

describe("changedLines", () => {
  it("추가 줄 번호(1-기준)와 삭제 수", () => {
    const base = "a\nb\nc\n";
    const cur = "a\nB2\nB3\nc\n"; // b → B2,B3(수정+추가), c 유지
    const r = changedLines(base, cur);
    expect([...r.added].sort((x, y) => x - y)).toEqual([2, 3]);
    expect(r.removed).toBe(1);
  });

  it("변경 없음·끝 추가", () => {
    expect(changedLines("x\n", "x\n")).toEqual({ added: new Set(), removed: 0 });
    const r = changedLines("x\n", "x\ny\n");
    expect(r.added.has(2)).toBe(true);
    expect(r.removed).toBe(0);
  });

  it("대규모 접두 변경도 줄 좌표 정확", () => {
    const base = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n");
    const cur = base.replace("line10", "CHANGED");
    const r = changedLines(base, cur);
    expect(r.added.size).toBe(1);
    expect(r.added.has(11)).toBe(true);
    expect(r.removed).toBe(1);
  });
});

describe("hunksOf", () => {
  it("추가·삭제 덩어리 — 현재 문서 줄 좌표", () => {
    const base = "a\nb\nc\n";
    const cur = "a\nB\nc\nd\n"; // b→B(수정), d 추가
    const h = hunksOf(base, cur);
    expect(h).toEqual([
      { kind: "del", line: 2, lines: 1, preview: "b" },
      { kind: "add", line: 2, lines: 1, preview: "B" },
      { kind: "add", line: 4, lines: 1, preview: "d" },
    ]);
  });

  it("변경 없음은 빈 목록", () => {
    expect(hunksOf("x\n", "x\n")).toEqual([]);
  });
});
