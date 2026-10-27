// 서식 복사/붙여넣기(Format Painter, ⌘⇧C/⌘⇧V) — 선택의 글자 서식을 기억해
// 다른 선택에 적용(Word 서식 복사). 원문은 마커 삽입 텍스트 편집뿐(§4-2).

import { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

export type CharMark = "strong" | "em" | "code" | "strike" | "highlight";

export interface PaintedFormat {
  marks: CharMark[];
  /** 문단 문맥 — 제목 수준(0=본문), 인용 여부. */
  heading: number;
  quote: boolean;
}

/** 위치의 글자 서식 — 구문 트리 노드를 올라가며 수집. 순수 함수. */
export function marksAt(state: EditorState, pos: number): CharMark[] {
  const out = new Set<CharMark>();
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    switch (node.name) {
      case "StrongEmphasis":
        out.add("strong");
        break;
      case "Emphasis":
        out.add("em");
        break;
      case "InlineCode":
        out.add("code");
        break;
      case "Strikethrough":
        out.add("strike");
        break;
      case "Highlight":
        out.add("highlight");
        break;
      default:
        break;
    }
    node = node.parent ?? null;
  }
  return [...out];
}

/** 위치의 문단 문맥 — 제목 수준·인용. 순수 함수.
 *  Setext(===/--- 밑줄) 제목도 수준으로 읽는다 — 못 읽으면 복사가 본문
 *  (heading 0)으로 기억돼 붙여넣을 때 대상 제목을 벗겨버린다. */
export function paraAt(state: EditorState, pos: number): { heading: number; quote: boolean } {
  let heading = 0;
  let quote = false;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (/^ATXHeading(\d)$/.exec(node.name)) {
      heading = Number(node.name.slice(-1));
    } else if (node.name === "SetextHeading1") {
      heading = 1;
    } else if (node.name === "SetextHeading2") {
      heading = 2;
    } else if (node.name === "Blockquote") {
      quote = true;
    }
    node = node.parent;
  }
  return { heading, quote };
}

/** 복사할 서식 — 선택 시작점 기준(빈 선택이면 커서). 순수 함수. */
export function formatAt(state: EditorState, pos: number): PaintedFormat {
  return { marks: marksAt(state, pos), ...paraAt(state, pos) };
}

// — 붓 상태(모듈 단일 — 창 안 에디터 뷰는 하나) —

let painted: PaintedFormat | null = null;

/** 붓 초기화 — 테스트·초기화용. */
export function resetPainted(): void {
  painted = null;
}

/** 서식 복사 — 커서/선택의 서식을 기억. 성공(무언가 복사됨) 여부 반환. */
export function copyFormat(view: EditorView): boolean {
  painted = formatAt(view.state, view.state.selection.main.from);
  return painted.marks.length > 0 || painted.heading > 0 || painted.quote;
}

/** 줄 시작이 문단 마커를 만들면 안 되는 블록(코드·수식·FM·각주 정의) 안인지. */
function inRawBlock(state: EditorState, lineFrom: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(lineFrom + 1, -1);
  while (node) {
    if (
      node.name === "FencedCode" ||
      node.name === "IndentedCode" ||
      node.name === "MathBlock" ||
      node.name === "FrontMatter" ||
      node.name === "FootnoteDef"
    ) {
      return true;
    }
    node = node.parent ?? null;
  }
  return false;
}

/** 줄이 Setext 밑줄(===/---)인지 — 구문 트리 노드로 판정(수평선과 구분). */
function isSetextUnderline(state: EditorState, line: { from: number; to: number }): boolean {
  if (!/^(?:={1,}|-{1,})\s*$/.test(state.doc.sliceString(line.from, line.to))) return false;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from + 1, -1);
  while (node) {
    if (node.name === "SetextHeading1" || node.name === "SetextHeading2") return true;
    if (node.name === "HorizontalRule") return false;
    node = node.parent ?? null;
  }
  return false;
}

/** 서식 붙여넣기 — 기억한 서식을 현재 선택에 적용. 복사된 적 없으면 false.
 *  글자 서식(마커 감싸기)과 문단 서식(제목 수준·인용)을 모두 옮긴다 —
 *  Word 서식 붓은 글자와 문단을 함께 복사한다. 복사 원본이 본문(제목 0·
 *  인용 아님)이면 대상의 제목·인용 마커를 벗기는 방향으로도 작동한다. */
export function pasteFormat(view: EditorView): boolean {
  if (!painted) return false;
  let sel = view.state.selection.main;
  const cur = formatAt(view.state, sel.from);
  const text = view.state.sliceDoc(sel.from, sel.to);
  // 글자 서식 — 이미 같은 서식이면 덧씌우지 않는다(set 의미론, 토글 아님).
  // 감싸기는 선택 전체를 다시 쓰므로 한 번에 순차 누적한다.
  const order: Array<[string, CharMark]> = [
    ["**", "strong"],
    ["*", "em"],
    ["`", "code"],
    ["~~", "strike"],
    ["==", "highlight"],
  ];
  let out = text;
  for (const [marker, mark] of order) {
    if (painted.marks.includes(mark) && !cur.marks.includes(mark)) {
      out = `${marker}${out}${marker}`;
    }
  }
  if (out !== text) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: out },
      selection: { anchor: sel.from + out.length },
      userEvent: "input.format",
    });
    sel = view.state.selection.main;
  }
  // 문단 서식 — 선택이 걸친 줄의 마커를 복사 원본과 같게 재조립. 글자
  // 감싸기와 줄 재작성은 범위가 겹쳐 한 트랜잭션에 담을 수 없어 두 번째
  // 트랜잭션으로 적용한다. 코드·수식·FM·각주 정의 블록 안 줄은 원문 보존.
  const doc = view.state.doc;
  const first = doc.lineAt(sel.from);
  const last = doc.lineAt(sel.to);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const dropped = new Set<number>();
  for (let n = first.number; n <= last.number; n++) {
    const line = doc.line(n);
    // 빈 줄은 문단이 아니다 — 끝 개행 뒤의 빈 마지막 세그먼트에 "## "같은
    // 홀로 마커만 만들지 않게.
    if (line.text.trim() === "") continue;
    if (inRawBlock(view.state, line.from)) continue;
    // 앞 줄 재조립 때 함께 처리한 Setext 밑줄(===/---)은 건너뛴다.
    if (dropped.has(n)) continue;
    // 기존 인용(중첩 포함)과 제목 마커를 벗긴 뒤 복사 서식으로 재조립.
    // "#x"·홀로 "#" 줄은 제목이 아니므로 벗기지 않는다 — 공백이 뒤따를 때만.
    const stripped = line.text
      .replace(/^(>\s?)+/, "")
      .replace(/^#{1,6}\s+/, "");
    let rebuilt = "";
    if (painted.quote) rebuilt += "> ";
    if (painted.heading > 0) rebuilt += `${"#".repeat(painted.heading)} `;
    rebuilt += stripped;
    // 다음 줄이 구문 트리에서 Setext 밑줄이면 ATX 재조립 뒤 남은 밑줄과
    // 그 앞 개행을 함께 지운다(수평선 ---은 Setext 노드가 아니라 그대로).
    // 밑줄은 선택 밖일 수 있어도 같은 문단의 일부다 — 선택 경계로 제한하지
    // 않는다.
    const next = n < doc.lines ? doc.line(n + 1) : null;
    if (next && isSetextUnderline(view.state, next)) {
      dropped.add(next.number);
      changes.push({ from: line.to, to: next.to, insert: "" });
    }
    if (rebuilt !== line.text) changes.push({ from: line.from, to: line.to, insert: rebuilt });
  }
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "input.format.para" });
  }
  return true;
}
