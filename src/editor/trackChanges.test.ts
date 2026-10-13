// 변경 추적 — 베이스라인 diff로 바뀐 줄 계산의 순수 단위 테스트.

import { describe, expect, it } from "vitest";

import { changedLines, shiftLineNo } from "./trackChanges";
import { hunksOf, revertChange } from "../components/TrackPanel";

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
      { kind: "del", line: 2, lines: 1, preview: "b", fromLine: 0, toLine: 0, restore: "b" },
      { kind: "add", line: 2, lines: 1, preview: "B", fromLine: 2, toLine: 2, restore: "" },
      { kind: "add", line: 4, lines: 1, preview: "d", fromLine: 4, toLine: 4, restore: "" },
    ]);
  });

  it("변경 없음은 빈 목록", () => {
    expect(hunksOf("x\n", "x\n")).toEqual([]);
  });
});

describe("revertChange", () => {
  const doc = "a\nB\nc\nd\n"; // 현재 — B는 수정된 줄(2줄), d는 추가(4줄)
  const line = (n: number) => {
    // 간단 문서 좌표: 줄 시작/끝 계산
    let from = 0;
    for (let i = 1; i < n; i++) from += doc.split("\n")[i - 1]!.length + 1;
    const text = doc.split("\n")[n - 1] ?? "";
    return { from, to: from + text.length };
  };

  it("add 덩어리 — 그 줄들(뒤 개행 포함) 삭제", () => {
    const h = { kind: "add" as const, line: 4, lines: 1, preview: "d", fromLine: 4, toLine: 4, restore: "" };
    const c = revertChange(h, line, 4);
    expect(c?.insert).toBe("");
    expect(doc.slice(c!.from, c!.to)).toBe("\nd");
  });

  it("del 덩어리 — 그 위치에 베이스라인 텍스트 재삽입", () => {
    const h = { kind: "del" as const, line: 2, lines: 1, preview: "b", fromLine: 0, toLine: 0, restore: "b" };
    const c = revertChange(h, line, 4);
    expect(c?.insert).toBe("b");
    expect(c?.from).toBe(c?.to); // 순수 삽입
  });

  it("경계 밖은 null", () => {
    const h = { kind: "add" as const, line: 9, lines: 1, preview: "", fromLine: 9, toLine: 9, restore: "" };
    expect(revertChange(h, line, 4)).toBeNull();
  });
});

describe("shiftLineNo — 저장 시 줄 재앵커", () => {
  it("위에서 줄 추가 → 아래 메모 줄이 밀림", () => {
    const old = "a\nb\nc\n";
    const cur = "a\nNEW\nb\nc\n";
    expect(shiftLineNo(3, old, cur)).toBe(4);
    expect(shiftLineNo(1, old, cur)).toBe(1); // 위는 그대로
  });

  it("위에서 줄 삭제 → 당겨짐, 삭제된 범위는 0(버림)", () => {
    const old = "a\nb\nc\n";
    const cur = "a\nc\n";
    expect(shiftLineNo(3, old, cur)).toBe(2);
    expect(shiftLineNo(2, old, cur)).toBe(0); // 삭제된 b 줄
  });

  it("변경 없음·아래 편집은 원줄", () => {
    expect(shiftLineNo(2, "a\nb\nc\n", "a\nb\nc\n")).toBe(2);
    expect(shiftLineNo(1, "a\nb\n", "a\nX\nc\n")).toBe(1);
  });
});
