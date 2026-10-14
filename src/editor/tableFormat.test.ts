// 표 자동 정렬 테스트 — 무손실(셀 내용·정렬 표시 보존)과 열 맞춤의 정확성.
// 전각 너비(한글=2) 반영과 이스케이프 \| 보존이 핵심 규칙.

import { describe, expect, it } from "vitest";

import { cellWidth, formatAllTables, formatTableText, tidyDocument,
} from "./tableFormat";

describe("cellWidth", () => {
  it("전각은 2, 반각은 1", () => {
    expect(cellWidth("abc")).toBe(3);
    expect(cellWidth("한글")).toBe(4);
    expect(cellWidth("a한b")).toBe(4);
  });
});

describe("formatTableText", () => {
  it("열 맞춤 — 전각 폭 반영", () => {
    const src = "|이름|설명|\n|---|---|\n|a|짧|\n|길이름|두 칸 설명|";
    expect(formatTableText(src)).toBe(
      "| 이름   | 설명       |\n| ------ | ---------- |\n| a      | 짧         |\n| 길이름 | 두 칸 설명 |",
    );
    // 끝 개행은 입력을 따른다.
    expect(formatTableText(src + "\n")).toBe(
      "| 이름   | 설명       |\n| ------ | ---------- |\n| a      | 짧         |\n| 길이름 | 두 칸 설명 |\n",
    );
  });

  it("정렬 표시 보존 — :-- 오른쪽 정렬은 셀도 오른쪽 정렬", () => {
    const out = formatTableText("| 항목 | 값 |\n| ---: | --- |\n| 1 | x |\n| 200 | yy |")!;
    expect(out.split("\n")[1]).toBe("| ---: | --- |");
    expect(out.split("\n")[2]).toBe("|    1 | x  |");
    expect(out.split("\n")[3]).toBe("|  200 | yy |");
    // 값 열 폭은 2(값=2, yy=2) — x는 한 칸 패딩.
    expect(out.split("\n")[2]).toContain("| x  |");
  });

  it("짧은 행은 빈 셀로 패딩, 이스케이프 \\| 는 셀 구분 아님", () => {
    const out = formatTableText("| a | b |\n| --- | --- |\n| one |\n| x \\| y | z |")!;
    const lines = out.split("\n");
    expect(lines[2]).toBe("| one    |   |");
    expect(lines[3]).toBe("| x \\| y | z |");
  });

  it("이미 정렬된 표는 null(디스패치 없음), 비-표도 null", () => {
    expect(formatTableText("| a | b |\n| --- | --- |\n")).toBeNull();
    expect(formatTableText("그냥 텍스트\n두 번째 줄\n")).toBeNull();
  });
});

describe("formatAllTables — 문서 전체 표 정리", () => {
  it("표 블록만 정리, 비표 줄·코드펜스 보존", () => {
    const doc = "서론\n\n|a|bb|\n|---|---|\n|1|2|\n\n\`\`\`\n|x|\n\`\`\`\n";
    const out = formatAllTables(doc);
    expect(out).toContain("| a | bb |");
    expect(out).toContain("| 1 | 2  |"); // 열 폭은 셋 중 최장에 맞춰짐
    expect(out).toContain("|x|"); // 펜스 안 무결
  });

  it("표 없는 문서는 무변경", () => {
    expect(formatAllTables("그냥 텍스트\n")).toBe("그냥 텍스트\n");
  });
});

describe("tidyDocument", () => {
  it("3줄+ 빈 줄 → 1줄, 끝 정리", () => {
    const doc = "a\n\n\n\nb\n\n\n";
    expect(tidyDocument(doc)).toBe("a\n\nb\n");
  });

  it("표 정렬 동반·줄 끝 공백(강제줄바꿈) 보존", () => {
    const doc = "|a|b|\n|---|---|\n|1|2|\n\n\n\n끝  \n";
    const out = tidyDocument(doc);
    expect(out).toContain("| a | b |");
    expect(out).toContain("끝  \n"); // 두 칸 유지
  });
});
