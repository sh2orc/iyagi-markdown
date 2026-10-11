// 서식 명령 — 모두 "원문에 기호를 삽입하는 텍스트 편집"이다(§4-1).
// AST를 재직렬화하지 않으므로 원문 보존 원칙(§4-2)이 자동으로 지켜진다.

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** 선택 각 줄의 앞뒤에 마커를 넣는다(굵게/기울임/취소선/코드). */
function wrapSelection(view: EditorView, marker: string): boolean {
  const changes = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to);
    // 이미 감싸져 있으면 제거(토글).
    if (text.startsWith(marker) && text.endsWith(marker) && text.length >= marker.length * 2) {
      const inner = text.slice(marker.length, text.length - marker.length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }
    return {
      changes: { from: range.from, to: range.to, insert: marker + text + marker },
      range: EditorSelection.range(
        range.from + marker.length,
        range.from + marker.length + text.length,
      ),
    };
  });
  view.dispatch(changes, { userEvent: "input.format" });
  return true;
}

export const toggleBold = (view: EditorView) => wrapSelection(view, "**");
export const toggleItalic = (view: EditorView) => wrapSelection(view, "*");
export const toggleStrikethrough = (view: EditorView) => wrapSelection(view, "~~");
export const toggleInlineCode = (view: EditorView) => wrapSelection(view, "`");

/** 인라인 링크 삽입: 선택 텍스트를 [텍스트](url)로. */
export function insertLink(view: EditorView, url = ""): boolean {
  const changes = view.state.changeByRange((range) => {
    const text = view.state.sliceDoc(range.from, range.to) || "";
    const insert = `[${text || "텍스트"}](${url || "https://"})`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(
        range.from + (text ? insert.length : 1),
      ),
    };
  });
  view.dispatch(changes, { userEvent: "input.format" });
  return true;
}

/** 각 선택 줄의 접두를 순환(있으면 제거, 없으면 추가). */
function prefixLines(
  view: EditorView,
  makePrefix: (lineText: string, lineNo: number) => string,
  matches: (lineText: string) => boolean,
): boolean {
  const state = view.state;
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from).number;
  const last = state.doc.lineAt(sel.to).number;
  const anyMatched = (() => {
    for (let n = first; n <= last; n++) {
      if (matches(state.doc.line(n).text)) return true;
    }
    return false;
  })();
  const changes: { from: number; to?: number; insert: string }[] = [];
  let orderedIdx = 0;
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    const stripped = line.text.replace(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+|>\s?)+/, "$1");
    const prefix = anyMatched ? "" : makePrefix(stripped, orderedIdx++);
    const insert = prefix + stripped;
    if (insert !== line.text) {
      changes.push({ from: line.from, to: line.to, insert });
    } else if (!anyMatched) {
      // 내용이 같아도(접두만) 위에서 이미 반영된다.
    }
  }
  if (changes.length === 0) return true;
  view.dispatch({ changes, userEvent: "input.format" });
  return true;
}

const isListLine = (text: string) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(text);

export const toggleBulletList = (view: EditorView) =>
  prefixLines(view, () => "- ", isListLine);
export const toggleOrderedList = (view: EditorView) =>
  prefixLines(view, (_t, i) => `${i + 1}. `, isListLine);
export const toggleQuote = (view: EditorView) =>
  prefixLines(view, () => "> ", (t) => /^\s*>\s?/.test(t));

/** 제목 수준 토글: 같은 수준이면 제거, 아니면 지정 수준으로. */
export function toggleHeading(view: EditorView, level: number): boolean {
  const state = view.state;
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from).number;
  const last = state.doc.lineAt(sel.to).number;
  const hashes = "#".repeat(level) + " ";
  const changes: { from: number; to?: number; insert: string }[] = [];
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    const m = /^(#{1,6})\s+/.exec(line.text);
    const current = m ? m[1].length : 0;
    if (current === level) {
      changes.push({ from: line.from, to: line.from + m![0].length, insert: "" });
    } else {
      const body = m ? line.text.slice(m[0].length) : line.text;
      changes.push({ from: line.from, to: line.to, insert: hashes + body });
    }
  }
  if (changes.length) view.dispatch({ changes, userEvent: "input.format" });
  return true;
}

/** 블록 수평선/수식/코드블록 삽입(빈 줄 하나를 만들어 넣는다). */
export function insertBlock(view: EditorView, block: string): boolean {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.from);
  const before = line.text.slice(0, sel.from - line.from);
  const after = line.text.slice(sel.to - line.from);
  const insert = `${before}\n\n${block}\n\n${after}`;
  const cursor = line.from + before.length + 2 + block.length + 2;
  view.dispatch(
    { changes: { from: line.from, to: line.to, insert }, selection: { anchor: Math.min(cursor, line.from + insert.length) } },
    { userEvent: "input.format" },
  );
  return true;
}

/** 표 스캐폴드 삽입. */
export function insertTable(view: EditorView, rows = 3, cols = 3): boolean {
  const cells = (c: number, fill: string) => Array.from({ length: c }, () => fill).join(" | ");
  const lines = [
    `| ${cells(cols, "열 제목")} |`,
    `| ${cells(cols, "---")} |`,
    ...Array.from({ length: rows }, () => `| ${cells(cols, " ")} |`),
  ];
  return insertBlock(view, lines.join("\n"));
}
