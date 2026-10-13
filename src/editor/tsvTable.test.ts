// TSV → 표 변환 — 모양 판정·변환의 순수 단위 테스트.

import { describe, expect, it } from "vitest";

import { looksLikeTsv, tsvToTable } from "./tsvTable";

const T = "\t";
const N = "\n";

describe("looksLikeTsv", () => {
  it("2줄 이상·탭 다수 줄이면 참", () => {
    expect(looksLikeTsv(`a${T}b${N}c${T}d`)).toBe(true);
    expect(looksLikeTsv(`이름${T}값${N}A${T}1${N}B${T}2`)).toBe(true);
  });

  it("한 줄·탭 없음·빈 텍스트는 거짓", () => {
    expect(looksLikeTsv(`a${T}b`)).toBe(false);
    expect(looksLikeTsv(`일반 텍스트${N}둘째 줄`)).toBe(false);
    expect(looksLikeTsv("")).toBe(false);
  });
});

describe("tsvToTable", () => {
  it("첫 줄 헤더 + 구분줄 + 데이터, 파이프 이스케이프", () => {
    const out = tsvToTable(`이름${T}값${N}A|1${T}1${N}B${T}2`);
    expect(out).toBe(
      `| 이름 | 값 |${N}| --- | --- |${N}| A\\|1 | 1 |${N}| B | 2 |`,
    );
  });

  it("열 수 불일치 — 최대 열로 확장, 부족 열은 빈 칸", () => {
    const out = tsvToTable(`a${T}b${N}1${N}2${T}3${T}4`);
    const rows = out.split(N);
    expect(rows[0]).toBe("| a | b |  |");
    expect(rows[2]).toBe("| 1 |  |  |");
    expect(rows[3]).toBe("| 2 | 3 | 4 |");
  });

  it("빈 문자열·빈 줄 무시", () => {
    expect(tsvToTable("")).toBe("");
    expect(tsvToTable(`a${T}b${N}${N}1${T}2`).split(N)).toHaveLength(3);
  });
});
