import { describe, expect, it } from "vitest";
import { merge3 } from "./diff";

describe("merge3", () => {
  const base = "a\nb\nc\nd\ne\n";
  it("서로 다른 곳의 수정은 합친다", () => {
    expect(merge3(base, "a\nB\nc\nd\ne\n", "a\nb\nc\nd\nE\nf\n")).toBe("a\nB\nc\nd\nE\nf\n");
    expect(merge3(base, "0\na\nb\nc\nd\ne\n", "a\nb\nc\ne\n")).toBe("0\na\nb\nc\ne\n");
  });
  it("한쪽만 바뀌었으면 그쪽을 따른다", () => {
    expect(merge3(base, base, "x\n")).toBe("x\n");
    expect(merge3(base, "x\n", base)).toBe("x\n");
  });
  it("같은 곳을 똑같이 고친 것은 한 번만 반영한다", () => {
    expect(merge3(base, "a\nB\nc\nd\ne\n", "a\nB\nc\nd\ne\nz\n")).toBe("a\nB\nc\nd\ne\nz\n");
  });
  it("같은 줄·맞닿은 줄을 다르게 고치면 합치지 않는다", () => {
    expect(merge3(base, "a\nB\nc\nd\ne\n", "a\nX\nc\nd\ne\n")).toBeNull();
    expect(merge3(base, "a\nB\nc\nd\ne\n", "a\nb\nC\nd\ne\n")).toBeNull();
    expect(merge3(base, "a\nb\nc\nd\ne\nmine\n", "a\nb\nc\nd\ne\ntheirs\n")).toBeNull();
  });
  it("무작위 비겹침 수정에서 양쪽 변경이 모두 살아남는다", () => {
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let round = 0; round < 300; round++) {
      const lines = Array.from({ length: 30 }, (_, n) => `line ${n}`);
      const mine = [...lines], theirs = [...lines];
      const p = rand(10), q = 15 + rand(10);
      mine[p] = `MINE ${round}`;
      if (rand(2)) theirs[q] = `THEIRS ${round}`; else theirs.splice(q, 1, `T1 ${round}`, `T2 ${round}`);
      const merged = merge3(lines.join("\n"), mine.join("\n"), theirs.join("\n"))!;
      const expected = [...theirs];
      expected[p] = `MINE ${round}`;
      expect(merged).toBe(expected.join("\n"));
    }
  });
});
