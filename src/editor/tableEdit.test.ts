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

// 입력 보조(17차) — 괄호 쌍·마커 감싸기.
import { typePair } from "./format";

describe("입력 보조(쌍·감싸기)", () => {
  it("빈 커서 ( — 쌍 삽입 후 가운데", () => {
    const view = new EditorView({ state: createDocState("본\n", "edit"), parent: document.body });
    view.dispatch({ selection: { anchor: 1 } });
    typePair(view, "(");
    expect(view.state.doc.toString()).toBe("본()\n");
    expect(view.state.selection.main.head).toBe(2);
    view.destroy();
    document.body.innerHTML = "";
  });

  it("선택 + $ — 인라인 수식으로 감싸기", () => {
    const view = new (EditorView)({
      state: createDocState("a E=mc^2 b\n", "edit"),
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: 2, head: 8 } });
    typePair(view, "$");
    expect(view.state.doc.toString()).toBe("a $E=mc^2$ b\n");
    expect(view.state.selection.main.from).toBe(3);
    view.destroy();
    document.body.innerHTML = "";
  });

  it("선택 + * — 굵게 마커 두 개로 감싸기", () => {
    const view = new (EditorView)({
      state: createDocState("말 강조 말\n", "edit"),
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: 2, head: 4 } });
    typePair(view, "*");
    expect(view.state.doc.toString()).toBe("말 **강조** 말\n");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("닫는 괄호 스킵 — () 사이에서 ) 입력", () => {
    const view = new (EditorView)({
      state: createDocState("()\n", "edit"),
      parent: document.body,
    });
    view.dispatch({ selection: { anchor: 1 } });
    // ")" 는 pairs에 없다 — 스킵 로직은 "(" 가 닫는 문자인 쌍(quote)에만 적용.
    // 닫는 괄호 스킵은 CM 기본 입력과 조합되므로 여기선 false(기본 처리 위임).
    expect(typePair(view, ")")).toBe(false);
    view.destroy();
    document.body.innerHTML = "";
  });
});

// 줄 편집(19차).
import { moveLines, duplicateLine, deleteLines } from "./format";

describe("줄 편집(이동·복제·삭제)", () => {
  it("Alt+↑ — 줄 위로 이동", () => {
    const view = new EditorView({ state: createDocState("a\nb\nc\n", "edit"), parent: document.body });
    view.dispatch({ selection: { anchor: 4 } }); // "c" 줄
    moveLines(view, true);
    expect(view.state.doc.toString()).toBe("a\nc\nb\n");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("Alt+↓ — 선택 두 줄 아래로 이동", () => {
    const view = new EditorView({ state: createDocState("a\nb\nc\nd\n", "edit"), parent: document.body });
    view.dispatch({ selection: { anchor: 0, head: 3 } }); // a,b
    moveLines(view, false);
    expect(view.state.doc.toString()).toBe("c\na\nb\nd\n");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("첫 줄 위로·마지막 줄 아래로 — 무동작", () => {
    const view = new EditorView({ state: createDocState("a\nb\n", "edit"), parent: document.body });
    view.dispatch({ selection: { anchor: 0 } });
    expect(moveLines(view, true)).toBe(false);
    view.dispatch({ selection: { anchor: 4 } });
    expect(moveLines(view, false)).toBe(false);
    view.destroy();
    document.body.innerHTML = "";
  });

  it("⌘D — 줄 복제", () => {
    const view = new EditorView({ state: createDocState("본문\n", "edit"), parent: document.body });
    view.dispatch({ selection: { anchor: 2 } });
    duplicateLine(view);
    expect(view.state.doc.toString()).toBe("본문\n본문\n");
    view.destroy();
    document.body.innerHTML = "";
  });

  it("⌘⇧K — 선택 줄들 삭제", () => {
    const view = new EditorView({ state: createDocState("a\nb\nc\n", "edit"), parent: document.body });
    view.dispatch({ selection: { anchor: 0, head: 3 } }); // a,b
    deleteLines(view);
    expect(view.state.doc.toString()).toBe("c\n");
    view.destroy();
    document.body.innerHTML = "";
  });
});

// — 표 삽입 크기 지정(대화상자가 부르는 형태) —
describe("insertTable(rows, cols)", async () => {
  const { insertTable } = await import("./format");
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");

  function mount(doc: string): EditorView {
    const host = document.createElement("div");
    document.body.append(host);
    return new EditorView({ state: EditorState.create({ doc }), parent: host });
  }

  it("지정한 행·열로 골격 생성", () => {
    const v = mount("");
    insertTable(v, 2, 4);
    // 삽입 블록 앞뒤로 빈 줄이 붙는다 — 표 본체만 본다.
    const lines = v.state.doc.toString().split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(4); // 헤더 + 구분 + 2행
    expect((lines[0]!.match(/열 제목/g) ?? []).length).toBe(4);
    expect(lines[1]).toBe("| --- | --- | --- | --- |");
    v.destroy();
  });

  it("1×1도 유효", () => {
    const v = mount("");
    insertTable(v, 1, 1);
    expect(v.state.doc.toString().split("\n").filter((l) => l.trim())).toHaveLength(3);
    v.destroy();
  });
});

// — 표 셀 Tab 이동(Word 표 탐색) —
describe("tabTableCell", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { tabTableCell } = await import("./format");

  function mount(doc: string, pos: number): EditorView {
    // selection 심기 — 없으면 기본 0이어서 lineAt(0) 크래시(표 밖 테스트).
    const host = document.createElement("div");
    document.body.append(host);
    const st = EditorState.create({ doc, selection: { anchor: pos } });
    return new EditorView({ state: st, parent: host });
  }

  const TABLE = "| 이름 | 값 | 비고 |\n|---|---|---|\n| a | 1 | x |\n| b | 2 | y |";

  it("Tab — 다음 셀 시작으로", () => {
    // 1행 데이터 "| a | 1 | x |" — a 뒤(셀1)에서 Tab → 셀2(1 앞).
    const base = TABLE.indexOf("| a");
    const v = mount(TABLE, base + 3);
    expect(tabTableCell(v, false)).toBe(true);
    const head = v.state.selection.main.head;
    expect(TABLE.slice(head, head + 1)).toBe("1");
    v.destroy();
  });

  it("Shift+Tab — 이전 셀로", () => {
    const one = TABLE.indexOf("1 |");
    const v = mount(TABLE, one + 1);
    expect(tabTableCell(v, true)).toBe(true);
    expect(TABLE.slice(v.state.selection.main.head, v.state.selection.main.head + 1)).toBe("a");
    v.destroy();
  });

  it("줄 끝 Tab — 다음 데이터 줄 첫 셀로(구분줄 건너뜀)", () => {
    const x = TABLE.indexOf("x");
    const v = mount(TABLE, x + 1);
    expect(tabTableCell(v, false)).toBe(true);
    expect(TABLE.slice(v.state.selection.main.head, v.state.selection.main.head + 1)).toBe("b");
    v.destroy();
  });

  it("마지막 셀 Tab — 같은 열 수의 새 행 추가 후 첫 셀로(Word 관례)", () => {
    const y = TABLE.indexOf("y");
    const v = mount(TABLE, y + 1);
    expect(tabTableCell(v, false)).toBe(true);
    const after = v.state.doc.toString();
    expect(after.endsWith("| b | 2 | y |\n| | | |")).toBe(true); // 열 3개 유지
    expect(v.state.selection.main.head).toBe(after.length - 5); // 새 행 첫 셀("| " 뒤)
    const first = TABLE.indexOf("이름") + 2;
    v.dispatch({ selection: { anchor: first } });
    expect(tabTableCell(v, true)).toBe(false); // 헤더 첫 셀 — 윗행 없음(폴백)
    // 두 번째 데이터 행 첫 셀에서 Shift+Tab → 첫 데이터 행 마지막 셀(x).
    const b = TABLE.indexOf("| b");
    v.dispatch({ selection: { anchor: b + 2 } });
    expect(tabTableCell(v, true)).toBe(true);
    expect(TABLE[v.state.selection.main.head]).toBe("x");
    v.destroy();
  });

  it("표 밖 — false", () => {
    const v = mount("일반 텍스트\n", 2);
    expect(tabTableCell(v, false)).toBe(false);
    v.destroy();
  });
});

// — 이미지 삽입(도구모음 버튼) —
describe("insertImageRef", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { insertImageRef } = await import("./format");

  it("![alt](rel) 삽입 후 alt 안에 커서", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const v = new EditorView({ state: EditorState.create({ doc: "" }), parent: host });
    insertImageRef(v, "assets/p.png", "설명");
    expect(v.state.doc.toString()).toBe("![설명](assets/p.png)\n");
    const sel = v.state.selection.main;
    expect(v.state.sliceDoc(sel.from, sel.to)).toBe("설명");
    v.destroy();
  });
});

// — 수식 삽입(도구모음 Σ) —
describe("insertMath", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { insertMath } = await import("./format");

  function mount(doc: string, sel?: { anchor: number; head?: number }): EditorView {
    const host = document.createElement("div");
    document.body.append(host);
    return new EditorView({
      state: EditorState.create({ doc, selection: sel }),
      parent: host,
    });
  }

  it("빈 커서 — 구분쌍 삽입, 커서 가운데", () => {
    const v = mount("a b");
    insertMath(v, false);
    expect(v.state.doc.toString()).toBe("$$a b"); // 커서는 두 $ 사이(1)
    expect(v.state.selection.main.head).toBe(1);
    v.destroy();
  });

  it("선택 감싸기 — 선택이 수식 내용으로", () => {
    const v = mount("값은 HERE 이다", { anchor: 3, head: 7 });
    insertMath(v, false);
    expect(v.state.doc.toString()).toContain("$HERE$");
    const sel = v.state.selection.main;
    expect(v.state.sliceDoc(sel.from, sel.to)).toBe("HERE");
    v.destroy();
  });

  it("블록 — $$..$$ 줄바꿈", () => {
    const v = mount("");
    insertMath(v, true);
    expect(v.state.doc.toString()).toBe("$$$$\n");
    v.destroy();
  });
});

// — 일반 텍스트 줄 들여쓰기(Tab 체인 끝) —
describe("indentLines", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { indentLines } = await import("./format");

  function mount(doc: string, a: number, b: number): EditorView {
    const host = document.createElement("div");
    document.body.append(host);
    return new EditorView({ state: EditorState.create({ doc, selection: { anchor: a, head: b } }), parent: host });
  }

  it("여러 줄 선택 — 2칸 들여쓰기(빈 줄 제외)", () => {
    const v = mount("a\nb\n\nc\n", 0, 6);
    expect(indentLines(v, false)).toBe(true);
    expect(v.state.doc.toString()).toBe("  a\n  b\n\n  c\n");
    v.destroy();
  });

  it("내어쓰기 — 1~2칸 제거, 한 줄 선택은 false", () => {
    const v = mount("  a\n   b\nc\n", 0, 10);
    expect(indentLines(v, true)).toBe(true);
    expect(v.state.doc.toString()).toBe("a\n b\nc\n");
    v.destroy();
    const v2 = mount("a\nb", 0, 1);
    expect(indentLines(v2, false)).toBe(false);
    v2.destroy();
  });
});

// — 대소문자 순환·줄 합치기 —
describe("cycleCase / joinCurrentLine", async () => {
  const { EditorState } = await import("@codemirror/state");
  const { EditorView } = await import("@codemirror/view");
  const { cycleCase, joinCurrentLine, wordCaseOf } = await import("./format");

  function mount(doc: string, a: number, b?: number): EditorView {
    const host = document.createElement("div");
    document.body.append(host);
    return new EditorView({ state: EditorState.create({ doc, selection: { anchor: a, head: b ?? a } }), parent: host });
  }

  it("대소문자 순환 — lower→UPPER→Title→lower", () => {
    expect(wordCaseOf("hello world")).toBe("lower");
    expect(wordCaseOf("HELLO WORLD")).toBe("upper");
    expect(wordCaseOf("Hello World")).toBe("title");
    const v = mount("hello world", 0, 11);
    cycleCase(v);
    expect(v.state.doc.toString()).toBe("HELLO WORLD");
    cycleCase(v); // UPPER → Title
    expect(v.state.doc.toString()).toBe("Hello World");
    cycleCase(v); // Title → lower
    expect(v.state.doc.toString()).toBe("hello world");
    v.destroy();
  });

  it("줄 합치기 — 공백 하나로, 하이픈 뒤는 그대로", () => {
    const v = mount("hello-\nworld", 3);
    joinCurrentLine(v);
    expect(v.state.doc.toString()).toBe("hello-world");
    v.destroy();
    const v2 = mount("가나\n다라", 2);
    joinCurrentLine(v2);
    expect(v2.state.doc.toString()).toBe("가나 다라");
    v2.destroy();
  });
});
