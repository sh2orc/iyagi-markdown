// 표 구조 순수 연산 — 위젯·우클릭 메뉴가 공유. 모두 ParsedTable을 복제해
// 변환해 돌려준다(원본 불변). 행 인덱스 0 = 헤더.

import type { ParsedTable } from "./widgets";

export interface CellRect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** 직사각 선택 정규화(시작 ≤ 끝). */
export function normRect(a: { r: number; c: number }, b: { r: number; c: number }): CellRect {
  return {
    r1: Math.min(a.r, b.r),
    c1: Math.min(a.c, b.c),
    r2: Math.max(a.r, b.r),
    c2: Math.max(a.c, b.c),
  };
}

const clone = (t: ParsedTable): ParsedTable => ({
  align: [...t.align],
  header: [...t.header],
  rows: t.rows.map((r) => [...r]),
});

const nCols = (t: ParsedTable): number => Math.max(t.header.length, 1);

/** afterRow(전역 행, 0=헤더) 뒤에 빈 행 삽입 — 0이면 헤더 바로 아래. */
export function insertRow(t: ParsedTable, afterRow: number): ParsedTable {
  const next = clone(t);
  const at = Math.max(0, Math.min(afterRow, next.rows.length));
  next.rows.splice(at, 0, Array.from({ length: nCols(t) }, () => ""));
  return next;
}

/** afterCol 뒤에 빈 열 삽입(-1 = 맨 왼쪽). */
export function insertCol(t: ParsedTable, afterCol: number): ParsedTable {
  const next = clone(t);
  const at = Math.max(0, Math.min(afterCol + 1, nCols(t)));
  next.header.splice(at, 0, "");
  next.align.splice(at, 0, null);
  for (const row of next.rows) row.splice(at, 0, "");
  return next;
}

/** 행들 삭제(인덱스 목록 — 다중 선택 반영). 헤더(0)는 지우지 않는다. */
export function deleteRows(t: ParsedTable, rows: number[]): ParsedTable {
  const kill = new Set(rows.filter((r) => r >= 1));
  const next = clone(t);
  next.rows = next.rows.filter((_, i) => !kill.has(i + 1));
  return next;
}

/** 열들 삭제(인덱스 목록). 전부 지워지면 null(표 폐기는 별도). */
export function deleteCols(t: ParsedTable, cols: number[]): ParsedTable | null {
  const kill = new Set(cols.filter((c) => c >= 0 && c < nCols(t)));
  if (kill.size >= nCols(t)) return null;
  const next = clone(t);
  next.header = next.header.filter((_, i) => !kill.has(i));
  next.align = next.align.filter((_, i) => !kill.has(i));
  next.rows = next.rows.map((r) => r.filter((_, i) => !kill.has(i)));
  return next;
}

/** 선택 영역 셀 내용 비우기. */
export function clearCells(t: ParsedTable, rect: CellRect): ParsedTable {
  const next = clone(t);
  for (let r = rect.r1; r <= rect.r2; r++) {
    if (r === 0) {
      for (let c = rect.c1; c <= rect.c2; c++) next.header[c] = "";
    } else {
      const row = next.rows[r - 1];
      if (row) for (let c = rect.c1; c <= rect.c2; c++) row[c] = "";
    }
  }
  return next;
}

/** 열 정렬 표시 변경(:---:/:---/---:). */
export function setColAlign(
  t: ParsedTable,
  col: number,
  align: "left" | "center" | "right",
): ParsedTable {
  const next = clone(t);
  if (col < 0 || col >= next.align.length) return next;
  next.align[col] = next.align[col] === align ? null : align; // 토글
  return next;
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 데이터 행을 col 기준으로 정렬(안정 정렬, 원문 무손실 — 순서만). */
export function sortRowsBy(t: ParsedTable, col: number, desc: boolean): ParsedTable {
  const next = clone(t);
  const rows = next.rows.map((row, i) => ({ row, i }));
  rows.sort((a, b) => {
    const av = a.row[col] ?? "";
    const bv = b.row[col] ?? "";
    return natural.compare(av.trim(), bv.trim()) || a.i - b.i;
  });
  if (desc) rows.reverse();
  next.rows = rows.map((x) => x.row);
  return next;
}

/** 선택 영역을 TSV로(엑셀·시트 붙여넣기 호환). */
export function tsvOf(t: ParsedTable, rect: CellRect): string {
  const lines: string[] = [];
  for (let r = rect.r1; r <= rect.r2; r++) {
    const cells: string[] = [];
    for (let c = rect.c1; c <= rect.c2; c++) {
      cells.push(r === 0 ? (t.header[c] ?? "") : (t.rows[r - 1]?.[c] ?? ""));
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}
