// 멀티커서 편집 단위 테스트 — ⌥⌘↑/↓ 커서 확장, 멀티 인지 복제, 폴스루 가드.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { addCursorAbove, addCursorBelow, extendedCursors } from "./multiCursor";
import { continueListOnEnter, duplicateLine, typePair } from "./format";

const makeView = (doc: string, cursors: number[]): EditorView =>
  new EditorView({
    state: EditorState.create({
      doc,
      // allowMultipleSelections 필수 — 없으면 상태가 단일 선택으로 붕괴된다.
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create(cursors.map((p) => EditorSelection.cursor(p)), cursors.length - 1),
    }),
    parent: document.body,
  });

const heads = (view: EditorView): number[] => view.state.selection.ranges.map((r) => r.head);

const DOC = "alpha beta\ngamma delta\nepsilon zeta\n"; // 줄 시작 0 / 11 / 23

describe("extendedCursors (⌥⌘↑/↓ 커서 확장)", () => {
  it("아래 줄 같은 열에 커서 추가", () => {
    const view = makeView(DOC, [2]);
    expect(addCursorBelow(view)).toBe(true);
    expect(heads(view)).toEqual([2, 13]); // 11 + 2
    view.destroy();
  });

  it("위 줄에도 동일(역방향)", () => {
    const view = makeView(DOC, [13]);
    expect(addCursorAbove(view)).toBe(true);
    expect(heads(view)).toEqual([2, 13]);
    view.destroy();
  });

  it("짧은 줄에서는 줄 끝으로 클램프", () => {
    const view = makeView("abcdefgh\nxy\n", [8]); // 첫 줄 끝(열 8)
    expect(addCursorBelow(view)).toBe(true);
    // 둘째 줄 길이 2 → 열 8 → 클램프 = 줄 끝(9+2).
    expect(heads(view)).toEqual([8, 11]);
    view.destroy();
  });

  it("문서 경계(첫 줄 위·끝 줄 아래)에서는 변화 없음", () => {
    const first = makeView(DOC, [0]);
    expect(addCursorAbove(first)).toBe(false);
    expect(heads(first)).toEqual([0]);
    first.destroy();
    // 끝 개행 없는 문서 — 마지막 줄 끝(34)에서 아래는 경계.
    const last = makeView("alpha beta\ngamma delta\nepsilon zeta", [34]);
    expect(addCursorBelow(last)).toBe(false);
    expect(heads(last)).toEqual([34]);
    last.destroy();
  });

  it("이미 커서가 있는 줄은 중복 추가 안 함", () => {
    // 커서 0(1줄)·11(2줄)에서 아래로: 0→11은 이미 있음(건너뜀), 11→23만 추가.
    const view = makeView(DOC, [0, 11]);
    expect(addCursorBelow(view)).toBe(true);
    expect(heads(view)).toEqual([0, 11, 23]);
    view.destroy();
  });

  it("순수 함수 — 선택이 커버하는 위치엔 추가 안 함, 확장 불가면 null", () => {
    // 커서 1(1줄)의 아래(2줄 열1=5)는 선택 4..7 안 → 스킵. 선택 head 7은 마지막
    // 줄 끝(문서 2줄)이라 아래가 없음 → 확장 없음 = null.
    const state = EditorState.create({
      doc: "abc\ndef",
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.range(4, 7)]),
    });
    expect(extendedCursors(state, false)).toBeNull();
    // 커서 2개가 같은 아래 지점을 가리키면 추가는 하나뿐(추가 간 중복 제거).
    const state2 = EditorState.create({
      doc: "abc\ndef\nghi",
      extensions: [EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(5)]),
    });
    const sel = extendedCursors(state2, false);
    expect(sel).not.toBeNull();
    expect(sel!.ranges.map((r) => r.head)).toEqual([1, 5, 9]);
  });
});

describe("duplicateLine 멀티커서", () => {
  it("각 커서 줄을 복제(서로 다른 줄)", () => {
    const view = makeView("aa\nbb\ncc\n", [1, 4]);
    expect(duplicateLine(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("aa\naa\nbb\nbb\ncc\n");
    view.destroy();
  });

  it("같은 줄에 커서 여럿이면 한 번만 복제", () => {
    const view = makeView("aa\nbb\n", [0, 2]);
    expect(duplicateLine(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("aa\naa\nbb\n");
    view.destroy();
  });

  it("단일 커서 동작 유지(사본 줄 시작)", () => {
    const view = makeView("aa\nbb\n", [1]);
    expect(duplicateLine(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("aa\naa\nbb\n");
    expect(heads(view)).toEqual([4]);
    view.destroy();
  });
});

describe("멀티커서 폴스루 가드", () => {
  it("typePair — 멀티커서에서는 기본 입력으로", () => {
    const view = makeView("aa\nbb\n", [1, 4]);
    expect(typePair(view, "(")).toBe(false);
    expect(view.state.doc.toString()).toBe("aa\nbb\n");
    view.destroy();
  });

  it("continueListOnEnter — 멀티커서에서는 기본 Enter", () => {
    const view = makeView("- one\n- two\n", [5, 11]);
    expect(continueListOnEnter(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("- one\n- two\n");
    view.destroy();
  });
});
