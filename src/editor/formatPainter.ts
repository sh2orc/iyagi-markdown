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

/** 위치의 문단 문맥 — 제목 수준·인용. 순수 함수. */
export function paraAt(state: EditorState, pos: number): { heading: number; quote: boolean } {
  let heading = 0;
  let quote = false;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (/^ATXHeading(\d)$/.exec(node.name)) {
      heading = Number(node.name.slice(-1));
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

/** 서식 붙여넣기 — 기억한 서식을 현재 선택에 적용. 복사된 적 없으면 false. */
export function pasteFormat(view: EditorView): boolean {
  if (!painted) return false;
  const sel = view.state.selection.main;
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
  }
  return true;
}
