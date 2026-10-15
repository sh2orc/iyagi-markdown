// 멀티커서 편집 — ⌥⌘↑/↓ 위·아래 커서 추가(VS Code "add cursor above/below").
// ⌥클릭 커서 추가는 EditorView.clickAddsSelectionRange, 다음 같은 단어 선택은
// @codemirror/search의 selectNextOccurrence(⌥⌘D)가 담당 — 배선은 cm.ts.
// Esc는 기본 키맵의 simplifySelection이 단일 커서로 되돌린다.

import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** 순수: 현재 선택 각 커서에서 한 줄 위/아래 같은 열에 커서를 늘린 선택.
 *  대상 줄이 없거나(문서 경계) 이미 커서가 있으면 그 커서는 건너뛴다.
 *  늘어날 커서가 없으면 null. */
export function extendedCursors(state: EditorState, up: boolean): EditorSelection | null {
  const doc = state.doc;
  const ranges = state.selection.ranges;
  const added: number[] = [];
  for (const r of ranges) {
    const line = doc.lineAt(r.head);
    const n = line.number + (up ? -1 : 1);
    if (n < 1 || n > doc.lines) continue;
    const target = doc.line(n);
    // 열 유지(짧은 줄에서는 줄 끝으로 클램프 — VS Code 동작).
    const pos = target.from + Math.min(r.head - line.from, target.length);
    if (ranges.some((o) => o.from <= pos && pos <= o.to)) continue; // 이미 커서/선택 있음
    if (added.includes(pos)) continue;
    added.push(pos);
  }
  if (added.length === 0) return null;
  const all = [
    ...ranges.map((r) => EditorSelection.range(r.from, r.to)),
    ...added.map((pos) => EditorSelection.cursor(pos)),
  ].sort((a, b) => a.from - b.from || (a.empty ? 0 : 1) - (b.empty ? 0 : 1));
  return EditorSelection.create(all, Math.min(state.selection.mainIndex, all.length - 1));
}

/** ⌥⌘↑ / ⌥⌘↓ — 각 커서의 위/아래 줄 같은 열에 커서 추가. */
export function addCursorAbove(view: EditorView): boolean {
  return addCursorLine(view, true);
}
export function addCursorBelow(view: EditorView): boolean {
  return addCursorLine(view, false);
}

function addCursorLine(view: EditorView, up: boolean): boolean {
  const sel = extendedCursors(view.state, up);
  if (!sel) return false;
  view.dispatch({ selection: sel, scrollIntoView: true, userEvent: "select.addCursor" });
  return true;
}
