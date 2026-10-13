// 서식 명령 — 모두 "원문에 기호를 삽입하는 텍스트 편집"이다(§4-1).
// AST를 재직렬화하지 않으므로 원문 보존 원칙(§4-2)이 자동으로 지켜진다.

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { formatTableText } from "./tableFormat";
import { collectHeadings, tocMarkdown } from "../links";
import { stripFrontMatter } from "./frontmatter";
import { syntaxTree } from "@codemirror/language";

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
export const toggleHighlight = (view: EditorView) => wrapSelection(view, "==");

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

// — 표 편집(Word 표 도구) — 파이프 구조는 그대로 두고 셀 단위로만 삽입·삭제한다.
// 고치지 않은 셀의 원문은 바이트 단위로 보존된다.

export interface TableBlock {
  /** 첫 행(헤더) 줄 번호. */
  firstLine: number;
  /** 마지막 줄 번호. */
  lastLine: number;
  /** 커서가 있는 줄 번호. */
  cursorLine: number;
}

/** 커서 주변의 GFM 표 블록을 찾는다(연속한 파이프 줄 + 구분 줄). */
/** 표 안에서 Tab/Shift+Tab — 다음/이전 셀 시작으로 커서(Word 표 탐색).
 *  줄 끝 셀에서 Tab은 다음 데이터 줄 첫 셀로. 마지막 셀이면 false(기본 동작). */
export function tabTableCell(view: EditorView, back: boolean): boolean {
  const t = tableAround(view);
  if (!t) return false;
  const doc = view.state.doc;
  const sel = view.state.selection.main.head;
  const line = doc.line(Math.min(Math.max(doc.lineAt(sel).number, t.firstLine), t.lastLine));
  const pipes: number[] = [];
  for (let i = 0; i < line.text.length; i++) {
    if (line.text[i] === "|" && line.text[i - 1] !== "\\") pipes.push(i);
  }
  if (pipes.length < 2) return false;
  // 셀 시작 오프셋 목록: [첫 파이프+1, 내부 경계 각 +1] — 셀 수 = 경계+1.
  const inner = pipes.slice(1, -1);
  const starts = [pipes[0]! + 1, ...inner.map((p) => p + 1)];
  // 커서의 현재 셀: 시작 오프셋 중 커서 이전 마지막(셀 안 어디든).
  let k = 0;
  for (let i = 0; i < starts.length; i++) {
    if (line.from + starts[i]! <= sel) k = i;
  }
  const next = back ? k - 1 : k + 1;
  if (next >= 0 && next < starts.length) {
    view.dispatch({ selection: { anchor: contentStart(line, starts[next]!) } });
    return true;
  }
  if (back) return false; // 첫 셀에서 Shift+Tab — 기본
  // 줄 끝 — 다음 데이터 줄(구분줄 건너뛰기) 첫 셀로.
  const nextData = Math.max(t.firstLine + 2, line.number + 1);
  if (nextData > t.lastLine) return false;
  const nl = doc.line(nextData);
  const firstPipe = nl.text.indexOf("|");
  if (firstPipe === -1) return false;
  view.dispatch({ selection: { anchor: contentStart(nl, firstPipe + 1) } });
  return true;
}

/** 열 시작 오프셋(파이프 뒤)에서 셀 내용 시작(공백 건너뛴 곳)으로. */
function contentStart(line: { text: string; from: number }, offset: number): number {
  let i = offset;
  while (i < line.text.length && line.text[i] === " ") i++;
  return line.from + i;
}

export function tableAround(view: EditorView): TableBlock | null {
  const doc = view.state.doc;
  const start = doc.lineAt(view.state.selection.main.head).number;
  const isRow = (n: number) => /^\s*\|.*\|\s*$/.test(doc.line(n).text) || /^\s*\|/.test(doc.line(n).text);
  const isSep = (n: number) => /^\s*\|[\s:|-]+\|\s*$/.test(doc.line(n).text);
  if (start < 1 || start > doc.lines) return null;
  // 커서 줄이 파이프 행이 아니면 인접 줄로 확장(표 위젯 클릭 직후 등).
  // 경계 검사를 먼저 — isRow(0)/isRow(lines+1)는 doc.line()이 던진다.
  let anchor = start;
  if (!isRow(start)) {
    if (start - 1 >= 1 && isRow(start - 1)) anchor = start - 1;
    else if (start + 1 <= doc.lines && isRow(start + 1)) anchor = start + 1;
    else return null;
  }
  let first = anchor;
  while (first > 1 && isRow(first - 1)) first -= 1;
  // 구분 줄 확인(첫 표 형식: first+1이 구분 줄이어야 표).
  if (first + 1 > doc.lines || !isSep(first + 1)) return null;
  // 구분 줄까지가 표의 시작부 — 데이터 행은 그 아래로 확장.
  let last = first + 1;
  while (last < doc.lines && isRow(last + 1) && !isSep(last + 1)) last += 1;
  return { firstLine: first, lastLine: last, cursorLine: Math.max(anchor, Math.min(anchor, last)) };
}

/** 줄 텍스트를 셀로 나눈다(이스케이프 \| 보존). */
function cellsOf(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (s[i] === "|") {
      out.push(cur);
      cur = "";
    } else cur += s[i];
  }
  out.push(cur);
  return out;
}

/** 커서의 열 인덱스(행 안에서 몇 번째 셀인가). */
function columnAt(view: EditorView, lineNo: number): number {
  const line = view.state.doc.line(lineNo);
  const head = view.state.selection.main.head;
  const rel = Math.min(Math.max(head - line.from, 0), line.length);
  let col = 0;
  for (let i = 0; i < rel; i++) {
    if (line.text[i] === "|" && line.text[i - 1] !== "\\") col += 1;
  }
  // 첫 파이프는 셀 구분이 아니므로 1 감소(0-based 첫 셀).
  return Math.max(0, col - 1);
}

/** 행 추가 — 커서 행 아래에 같은 열 수의 빈 셀 행. */
export function tableAddRow(view: EditorView): boolean {
  const t = tableAround(view);
  if (!t) return false;
  const doc = view.state.doc;
  const nCols = cellsOf(doc.line(t.firstLine).text).length;
  const after = doc.line(t.cursorLine);
  view.dispatch({
    changes: {
      from: after.to,
      insert: `\n| ${Array.from({ length: nCols }, () => " ").join(" | ")} |`,
    },
    selection: { anchor: after.to },
    userEvent: "input.tableRow",
  });
  return true;
}

/** 열 추가 — 모든 행(구분 줄 포함)의 커서 열 뒤에 셀 삽입. */
export function tableAddColumn(view: EditorView): boolean {
  const t = tableAround(view);
  if (!t) return false;
  const doc = view.state.doc;
  const col = columnAt(view, t.cursorLine);
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = t.firstLine; n <= t.lastLine; n++) {
    const line = doc.line(n);
    const sep = /^\s*\|[\s:|-]+\|\s*$/.test(line.text);
    const cells = cellsOf(line.text);
    const idx = Math.min(col + 1, cells.length);
    // 삽입 위치: idx번째 셀의 시작 "|" 바로 뒤.
    let pipes = 0;
    let pos = -1;
    for (let i = 0; i < line.text.length; i++) {
      if (line.text[i] === "|" && line.text[i - 1] !== "\\") {
        if (pipes === idx) {
          pos = i + 1;
          break;
        }
        pipes += 1;
      }
    }
    if (pos === -1) pos = line.text.length; // 끝에 붙이기(닫는 | 앞).
    const cell = sep ? " --- " : "  ";
    changes.push({ from: line.from + pos, to: line.from + pos, insert: `${cell}|` });
  }
  view.dispatch({ changes, userEvent: "input.tableColumn" });
  return true;
}

/** 행 삭제 — 커서 행 제거(마지막 행이면 표 제거는 하지 않고 빈 셀 유지). */
export function tableDeleteRow(view: EditorView): boolean {
  const t = tableAround(view);
  if (!t) return false;
  const doc = view.state.doc;
  if (t.cursorLine === t.firstLine || t.cursorLine === t.firstLine + 1) {
    // 헤더·구분 줄은 지우지 않는다(표 파괴 방지).
    return false;
  }
  const line = doc.line(t.cursorLine);
  // 줄과 개행 하나를 지운다(마지막 행이면 앞 개행).
  const delFrom = t.cursorLine < t.lastLine ? line.from : line.from - 1;
  const delTo = t.cursorLine < t.lastLine ? line.to + 1 : line.to;
  view.dispatch({
    changes: { from: delFrom, to: delTo },
    userEvent: "delete.tableRow",
  });
  return true;
}

/** 열 삭제 — 모든 행에서 커서 열 셀 제거. */
export function tableDeleteColumn(view: EditorView): boolean {
  const t = tableAround(view);
  if (!t) return false;
  const doc = view.state.doc;
  const col = columnAt(view, t.cursorLine);
  const total = cellsOf(doc.line(t.firstLine).text).length;
  if (total <= 1) return false; // 마지막 열은 지우지 않는다.
  const changes: { from: number; to: number }[] = [];
  for (let n = t.firstLine; n <= t.lastLine; n++) {
    const line = doc.line(n);
    // col번째 셀 = 여는 파이프(col번째)부터 닫는 파이프(col+1번째) 앞까지.
    // 닫는 파이프를 남겨 나머지 셀의 원문(공백 포함)이 그대로 보존되게 한다.
    let pipes = 0;
    let open = -1;
    let done = false;
    for (let i = 0; i < line.text.length; i++) {
      if (line.text[i] === "|" && line.text[i - 1] !== "\\") {
        if (pipes === col) open = i;
        else if (pipes === col + 1 && open !== -1) {
          changes.push({ from: line.from + open, to: line.from + i });
          done = true;
          break;
        }
        pipes += 1;
      }
    }
    if (!done && open !== -1) {
      // 닫는 파이프가 없는 관대한 행 — 셀 내용만.
      changes.push({ from: line.from + open, to: line.to });
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "delete.tableColumn" });
  return true;
}

/** 열 정렬 변경 — 구분 줄의 해당 셀만 :---:/:---/---:로 바꾼다(그 셀만 수정). */
export function tableAlignColumn(
  view: EditorView,
  align: "left" | "center" | "right" | "none",
): boolean {
  const t = tableAround(view);
  if (!t) return false;
  const sep = view.state.doc.line(t.firstLine + 1);
  const col = columnAtForAlign(view, t.cursorLine);
  // 구분 줄의 col번째 셀 찾기.
  let pipes = 0;
  let open = -1;
  let close = -1;
  for (let i = 0; i < sep.text.length; i++) {
    if (sep.text[i] === "|" && sep.text[i - 1] !== "\\") {
      if (pipes === col) open = i + 1;
      else if (pipes === col + 1) {
        close = i;
        break;
      }
      pipes += 1;
    }
  }
  if (open === -1 || close === -1 || close <= open) return false;
  // 기존 셀의 대시 수를 유지 — 콜론만 붙였다 뗐다 한다(왕복해도 폭 일정).
  const existing = sep.text.slice(open, close);
  const dashes = Math.max(3, (existing.match(/-/g) ?? []).length);
  const body = "-".repeat(dashes);
  const cell =
    align === "center" ? `:${body}:` : align === "left" ? `:${body}` : align === "right" ? `${body}:` : body;
  view.dispatch({
    changes: { from: sep.from + open, to: sep.from + close, insert: cell },
    userEvent: "input.tableAlign",
  });
  return true;
}

/** 정렬용 열 인덱스 — 커서 줄 기준(내부 재사용). */
function columnAtForAlign(view: EditorView, lineNo: number): number {
  const line = view.state.doc.line(Math.min(Math.max(lineNo, 1), view.state.doc.lines));
  const head = view.state.selection.main.head;
  const rel = Math.min(Math.max(head - line.from, 0), line.length);
  let col = 0;
  for (let i = 0; i < rel; i++) {
    if (line.text[i] === "|" && line.text[i - 1] !== "\\") col += 1;
  }
  return Math.max(0, col - 1);
}

/** Enter 시 목록 자동 계속 — 커서 줄이 목록 항목이면 다음 줄에 마커를 잇는다.
 *  내용이 비어 있으면 목록을 종료한다(마커 제거 — Word·모든 마크다운 에디터 표준).
 *  원하는 경우에만 삽입되는 사용자 입력 보조(§4-1: 모두 텍스트 편집). */
export function continueListOnEnter(view: EditorView): boolean {
  const state = view.state;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  // 커서가 줄 끝(또는 내용 뒤)에 있을 때만 — 중간 편집 중엔 방해하지 않는다.
  if (sel.head !== line.to) return false;
  const m = /^(\s*)([-*+]|\d+([.)]))\s+(\[[ xX]\]\s+)?(.*)$/.exec(line.text);
  if (!m) return false;
  const [, indent, marker, , task, content] = m;
  // 빈 항목 → 목록 종료: 마커를 지우고 일반 줄로.
  if (!content.trim()) {
    if (sel.head === line.to && line.from > 0) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: "" },
        selection: { anchor: line.from },
        userEvent: "input.listExit",
      });
      return true;
    }
    return false;
  }
  // 번호 목록은 증가, 불릿은 그대로. 작업 항목 표시도 잇는다(미완료로).
  const nextMarker = /\d/.test(marker) ? `${Number(marker.replace(/[^\d]/g, "")) + 1}${marker.slice(-1)}` : marker;
  const insert = `\n${indent}${nextMarker} ${task ? "[ ] " : ""}`;
  view.dispatch({
    changes: { from: line.to, insert },
    selection: { anchor: line.to + insert.length },
    userEvent: "input.listContinue",
  });
  return true;
}

/** 목록 항목 Tab/Shift-Tab 들여쓰기(Word 표준 동작) — 커서 줄의 목록 마커
 *  앞 공백을 2칸 단위로 늘리거나 줄인다. 원문은 공백 삽입·제거만(§4-1). */
export function indentListItem(view: EditorView, outdent: boolean): boolean {
  const state = view.state;
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  const m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line.text);
  if (!m) return false;
  const indent = m[1].length;
  if (outdent) {
    if (indent === 0) return false;
    // 2칸(또는 남은 만큼) 제거.
    const remove = Math.min(2, indent);
    view.dispatch({
      changes: { from: line.from, to: line.from + remove },
      userEvent: "input.listOutdent",
    });
    return true;
  }
  view.dispatch({
    changes: { from: line.from, insert: "  " },
    userEvent: "input.listIndent",
  });
  return true;
}

/** 입력 보조 — 괄호 쌍·마커 감싸기(Word 자동 고침 중 무손실 항목만).
 *  모두 커서/선택에 대한 텍스트 삽입이며 원문 보존 원칙(§4-2)과 무관하게
 *  사용자가 되돌릴 수 있는 일반 편집이다. */
export function typePair(view: EditorView, ch: string): boolean {
  const sel = view.state.selection.main;
  // ① 쌍 문자: 빈 커서면 닫는 쪽을 함께, 선택이 있으면 감싼다.
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "\"": "\"", "'": "'" };
  const close = pairs[ch];
  if (close) {
    if (!sel.empty) {
      const inner = view.state.sliceDoc(sel.from, sel.to);
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: ch + inner + close },
        selection: { anchor: sel.from + 1, head: sel.to + 1 },
        userEvent: "input.pair",
      });
      return true;
    }
    // 이미 열린 쌍 바로 뒤에서 닫는 문자 입력 → 닫는 쪽만 통과(스킵).
    // (간단히: 커서 앞이 같은 열림이고 뒤가 이미 닫힘이면 닫는 문자만 삽입)
    const before = view.state.sliceDoc(Math.max(0, sel.head - 1), sel.head);
    const after = view.state.sliceDoc(sel.head, Math.min(view.state.doc.length, sel.head + 1));
    if (ch === close && before === ch && after === close) {
      view.dispatch({ selection: { anchor: sel.head + 1 } });
      return true;
    }
    view.dispatch({
      changes: { from: sel.head, insert: ch + close },
      selection: { anchor: sel.head + 1 },
      userEvent: "input.pair",
    });
    return true;
  }
  // ② 마크다운 마커 감싸기: 선택이 있을 때만. 같은 문자 두 개로 감싼다.
  const markers: Record<string, number> = { "*": 2, "~": 2, $: 1, "`": 1, "=": 1 };
  const n = markers[ch];
  if (n && !sel.empty) {
    const pair = ch.repeat(n);
    const inner = view.state.sliceDoc(sel.from, sel.to);
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: pair + inner + pair },
      selection: { anchor: sel.from + pair.length, head: sel.to + pair.length },
      userEvent: "input.wrap",
    });
    return true;
  }
  return false;
}

/** 줄(또는 선택 줄들) 이동 — Alt+↑/↓. 이동은 줄 단위 잘라내기+붙여넣기로,
 *  이동한 줄의 원문 바이트는 그대로다(§4-2). */
export function moveLines(view: EditorView, up: boolean): boolean {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const fromLine = doc.lineAt(sel.from);
  const toLine = doc.lineAt(sel.to);
  if (up ? fromLine.number === 1 : toLine.number === doc.lines) return false;
  const text = doc.sliceString(fromLine.from, toLine.to);
  if (up) {
    const above = doc.line(fromLine.number - 1);
    view.dispatch({
      changes: [
        { from: above.from, to: toLine.to, insert: `${text}\n${above.text}` },
      ],
      selection: { anchor: sel.from - above.text.length - 1, head: sel.to - above.text.length - 1 },
      userEvent: "input.moveLines",
      scrollIntoView: true,
    });
  } else {
    const below = doc.line(toLine.number + 1);
    view.dispatch({
      changes: [
        { from: fromLine.from, to: below.to, insert: `${below.text}\n${text}` },
      ],
      selection: { anchor: sel.from + below.text.length + 1, head: sel.to + below.text.length + 1 },
      userEvent: "input.moveLines",
      scrollIntoView: true,
    });
  }
  return true;
}

/** 커서 줄 복제 — ⌘D(아래에 사본). 원문은 같은 줄이 반복될 뿐이다. */
export function duplicateLine(view: EditorView): boolean {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const line = doc.lineAt(sel.head);
  view.dispatch({
    changes: { from: line.to, insert: `\n${line.text}` },
    selection: { anchor: sel.head + line.text.length + 1 },
    userEvent: "input.duplicateLine",
    scrollIntoView: true,
  });
  return true;
}

/** 선택 줄들 삭제 — ⌘⇧K(VS Code 표준). */
export function deleteLines(view: EditorView): boolean {
  const doc = view.state.doc;
  const sel = view.state.selection.main;
  const fromLine = doc.lineAt(sel.from);
  const toLine = doc.lineAt(sel.to);
  const from = fromLine.from;
  const to = toLine.number < doc.lines ? toLine.to + 1 : Math.max(from - 1, fromLine.from);
  view.dispatch({
    changes: { from, to },
    userEvent: "delete.deleteLines",
  });
  return true;
}


// — 표 자동 정렬(tableFormat) —

/** 커서(또는 선택이 닿는) 표를 정렬된 형태로 다시 쓴다(원문 무손실 —
 *  셀 내용·정렬 표시 유지, 배열만 바뀐다). */
export function formatTable(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection.main;
  const found: Array<{ from: number; to: number }> = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const hits = node.from <= sel.head && sel.head <= node.to;
      const overlaps = node.from < sel.to && sel.from < node.to;
      if (hits || overlaps) found.push({ from: node.from, to: node.to });
    },
  });
  const table = found[found.length - 1];
  if (!table) return false;
  const formatted = formatTableText(state.sliceDoc(table.from, table.to));
  if (formatted === null) return false;
  view.dispatch({
    changes: { from: table.from, to: table.to, insert: formatted },
    userEvent: "format.table",
  });
  return true;
}


/** 목차 삽입 — 제목에서 마크다운 목차를 커서에(GitHub식 앵커). 원문 무손실:
 *  순수 텍스트 삽입일 뿐이고 내보내기·렌더 모두 표준 링크로 동작한다. */
export function insertToc(view: EditorView): boolean {
  const doc = view.state.doc.toString();
  const headings = collectHeadings(stripFrontMatter(doc));
  const md = tocMarkdown(headings);
  if (!md) return false;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: `${md}\n` },
    selection: { anchor: sel.from },
    userEvent: "input.insertToc",
  });
  return true;
}
