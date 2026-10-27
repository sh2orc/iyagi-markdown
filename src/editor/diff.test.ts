// 줄 diff 단위 테스트 — LCS 정확성·재정렬·합침·요약.

import { describe, expect, it } from "vitest";

import { diffLines, diffSummary } from "./diff";

describe("diffLines", () => {
  it("동일 문서 — 전부 same", () => {
    const ops = diffLines("a\nb\nc", "a\nb\nc");
    expect(ops.every((o) => o.kind === "same")).toBe(true);
    expect(diffSummary(ops)).toEqual({ added: 0, removed: 0 });
  });

  it("가운데 줄 교체 — del+add", () => {
    const ops = diffLines("a\nold\nc", "a\nnew\nc");
    expect(ops.some((o) => o.kind === "del" && o.text.includes("old"))).toBe(true);
    expect(ops.some((o) => o.kind === "add" && o.text.includes("new"))).toBe(true);
    const sum = diffSummary(ops);
    expect(sum).toEqual({ added: 1, removed: 1 });
  });

  it("순수 추가·삭제", () => {
    expect(diffSummary(diffLines("a\nb", "a\nb\nc"))).toEqual({ added: 1, removed: 0 });
    expect(diffSummary(diffLines("a\nb\nc", "a\nc"))).toEqual({ added: 0, removed: 1 });
  });

  it("재정렬(이동) 감지 — 순서 보존", () => {
    const ops = diffLines("1\n2\n3\n4\n5", "1\n3\n2\n4\n5");
    const sum = diffSummary(ops);
    expect(sum.added + sum.removed).toBeGreaterThanOrEqual(2); // 최소 한 쌍
  });

  it("연속 같은 종류는 항으로 합쳐진다", () => {
    const ops = diffLines("a\nb\nc", "x\ny\nz");
    // 전체 교체 — del 1항(3줄) + add 1항(3줄)
    expect(ops.length).toBeLessThanOrEqual(3);
    expect(ops[0]?.kind).toBe("del");
    expect(ops[0]?.text.split("\n")).toHaveLength(3);
  });

  it("빈 문서 왕복", () => {
    // split 관례상 빈 문자열도 [''] 한 줄 — 교체 1↔1로 대칭.
    expect(diffSummary(diffLines("", "a"))).toEqual({ added: 1, removed: 1 });
    expect(diffSummary(diffLines("a", ""))).toEqual({ added: 1, removed: 1 });
  });

  it("큰 문서의 중복·재정렬도 양쪽 원문을 정확히 재구성한다", () => {
    const lines = Array.from({ length: 2_100 }, (_, i) => `line ${i % 17}`);
    const before = ["start", ...lines, "end"].join("\n");
    const after = ["start", "inserted", ...lines.slice(1), lines[0], "end"].join("\n");
    const ops = diffLines(before, after);
    expect(ops.filter((op) => op.kind !== "add").map((op) => op.text).join("\n")).toBe(before);
    expect(ops.filter((op) => op.kind !== "del").map((op) => op.text).join("\n")).toBe(after);
  });

  it("긴 문서의 끝부분 변경을 생략 안내나 가짜 추가 줄로 대체하지 않는다", () => {
    const prefix = Array.from({ length: 12_100 }, (_, i) => `line ${i}`).join("\n");
    const ops = diffLines(`${prefix}\nold`, `${prefix}\nnew`);
    expect(diffSummary(ops)).toEqual({ added: 1, removed: 1 });
    expect(ops.filter((op) => op.kind !== "del").map((op) => op.text).join("\n")).toBe(`${prefix}\nnew`);
  });
});
