// 표 구조 순수 연산 단위 테스트 — 행/열 삽입·삭제, 선택 비우기, 정렬, TSV.

import { describe, expect, it } from "vitest";

import type { ParsedTable } from "./widgets";
import {
  clearCells,
  deleteCols,
  deleteRows,
  insertCol,
  insertRow,
  normRect,
  setColAlign,
  sortRowsBy,
  tsvOf,
} from "./tableOps";

const T: ParsedTable = {
  align: [null, null],
  header: ["h1", "h2"],
  rows: [
    ["b2", "x"],
    ["a10", "y"],
    ["b1", "z"],
  ],
};

describe("tableOps", () => {
  it("insertRow — 헤더 바로 아래(0)·첫 데이터 행 뒤(1), 원본 불변", () => {
    expect(insertRow(T, 0).rows[0]).toEqual(["", ""]); // 헤더와 첫 데이터 행 사이
    expect(insertRow(T, 1).rows[1]).toEqual(["", ""]);
    expect(insertRow(T, 0).rows.length).toBe(4);
    expect(T.rows.length).toBe(3); // 원본 불변
  });

  it("insertCol — 맨 왼쪽(-1 뒤)과 끝, 정렬 배열 동기", () => {
    const left = insertCol(T, -1);
    expect(left.header).toEqual(["", "h1", "h2"]);
    expect(left.align.length).toBe(3);
    const right = insertCol(T, 1);
    expect(right.header).toEqual(["h1", "h2", ""]);
    expect(right.rows[0]).toEqual(["b2", "x", ""]);
  });

  it("deleteRows — 데이터 행만(헤더 보존), 다중", () => {
    const next = deleteRows(T, [1, 3]);
    expect(next.rows).toEqual([["a10", "y"]]);
    expect(next.header).toEqual(["h1", "h2"]);
  });

  it("deleteCols — 다중 삭제, 전부 지우면 null", () => {
    const next = deleteCols(T, [0])!;
    expect(next.header).toEqual(["h2"]);
    expect(next.rows[0]).toEqual(["x"]);
    expect(deleteCols(T, [0, 1])).toBeNull();
  });

  it("clearCells — 헤더 포함 영역 비우기", () => {
    const next = clearCells(T, normRect({ r: 0, c: 1 }, { r: 1, c: 1 }));
    expect(next.header[1]).toBe("");
    expect(next.rows[0][1]).toBe("");
    expect(next.rows[1][1]).toBe("y"); // 영역 밖 불변
  });

  it("setColAlign — 토글(같은 값이면 해제)", () => {
    const on = setColAlign(T, 0, "center");
    expect(on.align[0]).toBe("center");
    expect(setColAlign(on, 0, "center").align[0]).toBeNull();
  });

  it("sortRowsBy — 자연 정렬(b1 < b2 < a10 아니고 a10 < b1 < b2), 내림차순 반전", () => {
    const asc = sortRowsBy(T, 0, false);
    expect(asc.rows.map((r) => r[0])).toEqual(["a10", "b1", "b2"]);
    const desc = sortRowsBy(T, 0, true);
    expect(desc.rows.map((r) => r[0])).toEqual(["b2", "b1", "a10"]);
  });

  it("tsvOf — 사각 영역 탭 구분(헤더 포함)", () => {
    expect(tsvOf(T, normRect({ r: 0, c: 0 }, { r: 1, c: 1 }))).toBe("h1\th2\nb2\tx");
  });
});
