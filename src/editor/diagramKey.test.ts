import { describe, expect, it } from "vitest";

import { clampDiagramPct, diagramKey } from "./diagramKey";

describe("diagramKey", () => {
  it("들여쓰기·줄 끝 공백·빈 줄 차이는 같은 키(편집기 펜스 본문 ↔ markdown-it 내용)", () => {
    const a = diagramKey("graph TD;\n  A-->B;\n");
    const b = diagramKey("graph TD;   \nA-->B;\n\n");
    expect(a).toBe(b);
    expect(a).toMatch(/^m[0-9a-f]{8}$/);
  });

  it("내용이 다르면 다른 키", () => {
    expect(diagramKey("graph TD; A-->B;")).not.toBe(diagramKey("graph TD; A-->C;"));
  });
});

describe("clampDiagramPct", () => {
  it("10~100 정수로 묶는다", () => {
    expect(clampDiagramPct(3)).toBe(10);
    expect(clampDiagramPct(140)).toBe(100);
    expect(clampDiagramPct(42.6)).toBe(43);
  });
});
