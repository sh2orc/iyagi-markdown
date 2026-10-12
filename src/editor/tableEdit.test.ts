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

// 목록 자동 계속(14차) — Enter 흐름.
import { continueListOnEnter } from "./format";

describe("목록 자동 계속(Enter)", () => {
  it("불릿 — 내용 있으면 다음 항목 생성", () => {
    const view = viewWith("- 하나\n", 4); // 줄 끝
    continueListOnEnter(view);
    expect(view.state.doc.toString()).toBe("- 하나\n- \n");
    expect(view.state.selection.main.head).toBe(7); // 마커 뒤(커서 즉시 입력 위치)
    view.destroy();
    document.body.innerHTML = "";
  });

  it("번호 — 증가한 번호로 잇는다", () => {
    const view = viewWith("2. 둘\n", 4);
    continueListOnEnter(view);
    expect(view.state.doc.toString()).toBe("2. 둘\n3. \n");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("빈 항목 — 목록 종료(마커 제거)", () => {
    const view = viewWith("- 하나\n- ", 7);
    continueListOnEnter(view);
    expect(view.state.doc.toString()).toBe("- 하나\n");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("작업 항목 — 미완료 체크박스로 잇는다", () => {
    const view = viewWith("- [x] 끝난 일\n", 10);
    continueListOnEnter(view);
    expect(view.state.doc.toString()).toBe("- [x] 끝난 일\n- [ ] \n");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("들여쓰기 유지·중간 커서·일반 문단은 방해 없음", () => {
    const view = viewWith("  - 항목\n", 6);
    continueListOnEnter(view);
    expect(view.state.doc.toString()).toBe("  - 항목\n  - \n");
    view.destroy();
    const mid = viewWith("- 항목\n", 2); // 중간
    expect(continueListOnEnter(mid)).toBe(false);
    mid.destroy();
    const plain = viewWith("일반 문단\n", 4);
    expect(continueListOnEnter(plain)).toBe(false);
    plain.destroy();
    document.body.innerHTML = "";
  });
});

// 목록 들여쓰기 Tab/Shift-Tab(15차).
import { indentListItem } from "./format";

describe("목록 들여쓰기(Tab)", () => {
  it("Tab — 마커 앞 2공백 추가", () => {
    const view = viewWith("- 항목\n", 4);
    indentListItem(view, false);
    expect(view.state.doc.toString()).toBe("  - 항목\n");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("Shift-Tab — 2공백 제거, 1공백이면 그만큼만", () => {
    const view = viewWith("  - 항목\n", 6);
    indentListItem(view, true);
    expect(view.state.doc.toString()).toBe("- 항목\n");
    const odd = viewWith(" - 항목\n", 5);
    indentListItem(odd, true);
    expect(odd.state.doc.toString()).toBe("- 항목\n");
    view.destroy();
    odd.destroy();
    document.body.innerHTML = "";
  });

  it("최상위 항목 Shift-Tab·일반 문단 Tab — 무동작(기본 동작 유지)", () => {
    const top = viewWith("- 항목\n", 4);
    expect(indentListItem(top, true)).toBe(false);
    const plain = viewWith("문단\n", 2);
    expect(indentListItem(plain, false)).toBe(false);
    top.destroy();
    plain.destroy();
    document.body.innerHTML = "";
  });
});
