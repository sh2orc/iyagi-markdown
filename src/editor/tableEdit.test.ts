// 표 편집 명령 — 파이프 구조 보존 검증(변경되지 않은 셀은 바이트 그대로).
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";

import { createDocState } from "./cm";
import {
  tableAddColumn,
  tableAddRow,
  tableAround,
  tableDeleteColumn,
  tableDeleteRow,
} from "./format";

function viewWith(doc: string, cursor: number): EditorView {
  const view = new EditorView({
    state: createDocState(doc, "edit").update({ selection: { anchor: cursor } }).state,
    parent: document.body,
  });
  return view;
}

const TABLE = `| 이름 | 값 | 비고 |
|---|:---:|---:|
| a | 1 | x |
| b | 2 | y |
`;

describe("표 편집(Word 표 도구)", () => {
  it("커서 주변 표 인식", () => {
    const view = viewWith(`앞 문단\n\n${TABLE}\n뒤 문단\n`, 12);
    const t = tableAround(view);
    expect(t).not.toBeNull();
    expect(t!.firstLine).toBe(3);
    expect(t!.lastLine).toBe(6);
    view.destroy();
    document.body.innerHTML = "";
  });

  it("행 추가 — 열 수 유지, 다른 셀 불변", () => {
    const view = viewWith(TABLE, TABLE.indexOf("| a"));
    tableAddRow(view);
    const lines = view.state.doc.toString().split("\n");
    expect(lines[2]).toBe("| a | 1 | x |"); // 기존 행 불변
    expect(lines[3]).toBe("|   |   |   |"); // 새 빈 행(3열)
    expect(lines[4]).toBe("| b | 2 | y |");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("열 추가 — 전 행에 셀 삽입, 구분 줄 포함", () => {
    const view = viewWith(TABLE, TABLE.indexOf("| a") + 3); // a행 1열
    tableAddColumn(view);
    const lines = view.state.doc.toString().split("\n");
    expect(lines[0]).toBe("| 이름 |  | 값 | 비고 |"); // 1열 뒤 삽입
    expect(lines[1]).toBe("|---| --- |:---:|---:|");
    expect(lines[2]).toBe("| a |  | 1 | x |");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("행 삭제 — 헤더·구분 줄 보호", () => {
    const view = viewWith(TABLE, TABLE.indexOf("| a"));
    expect(tableDeleteRow(view)).toBe(true); // 데이터 행 삭제
    expect(view.state.doc.toString()).not.toContain("| a |");
    // 커서를 헤더로 옮겨 시도 → 거부.
    const hdr = view.state.doc.toString().indexOf("| 이름");
    view.dispatch({ selection: { anchor: hdr } });
    expect(tableDeleteRow(view)).toBe(false);
    expect(view.state.doc.toString()).toContain("| 이름");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("열 삭제 — 지정 열만 제거", () => {
    const view = viewWith(TABLE, TABLE.indexOf("| a") + 3);
    tableDeleteColumn(view);
    const lines = view.state.doc.toString().split("\n");
    expect(lines[0]).toBe("| 값 | 비고 |");
    expect(lines[2]).toBe("| 1 | x |");
    view.destroy();
    document.body.innerHTML = "";
  });
});

// 정렬 명령은 6차에서 추가 — 같은 파일에 이어서.
import { tableAlignColumn } from "./format";

describe("표 정렬(6차)", () => {
  it("커서 열 정렬 변경 — 구분 줄의 해당 셀만 수정", () => {
    const view = viewWith(TABLE, TABLE.indexOf("| a") + 3);
    tableAlignColumn(view, "center");
    const lines = view.state.doc.toString().split("\n");
    expect(lines[1]).toBe("|:---:|:---:|---:|"); // 0번 열만 :---: 로
    // 나머지 행 불변.
    expect(lines[2]).toBe("| a | 1 | x |");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("오른쪽 정렬 → 기본 해제 왕복", () => {
    const view = viewWith(TABLE, TABLE.indexOf("| a") + 3);
    tableAlignColumn(view, "right");
    expect(view.state.doc.toString().split("\n")[1]).toBe("|---:|:---:|---:|");
    tableAlignColumn(view, "none");
    expect(view.state.doc.toString().split("\n")[1]).toBe("|---|:---:|---:|");
    view.destroy();
    document.body.innerHTML = "";
  });
});
