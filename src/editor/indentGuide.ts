// 들여쓰기 가이드 — 중첩 목록 등 2공백 들여쓰기에 세로 안내선(VS Code·
// Obsidian식). 안내선은 선행 공백 텍스트 위에 그라디언트로 그린다 — 범위
// 너비가 곧 들여쓰기 폭이라 위치가 정확하다(비례 폰트에서도).

import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, ViewPlugin, EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";

import { previewBehavior } from "./livePreview";

/** 순수: 줄 텍스트의 들여쓰기 단계(2공백 1단계, 절삭). 코드펜스 내부 판별은 별도. */
export function indentLevelOf(lineText: string): number {
  const spaces = /^ */.exec(lineText)![0].length;
  return Math.floor(spaces / 2);
}

/** 이 위치가 코드 블록(펜스·들여쓰기 코드) 안인지 — 가이드를 그리지 않는다. */
function insideCode(state: Parameters<typeof syntaxTree>[0], pos: number): boolean {
  let node: { name: string; from: number; to: number; parent: unknown } | null =
    syntaxTree(state).resolveInner(pos, 1) as unknown as { name: string; from: number; to: number; parent: unknown } | null;
  while (node) {
    if (node.name === "FencedCode" || node.name === "CodeText" || node.name === "CodeMark" || node.name === "IndentedCode") {
      return true;
    }
    node = (node.parent ?? null) as typeof node;
  }
  return false;
}

/** 공백 폭 실측 캐시 — 폰트·크기 바뀌면 다시 잰다(문자열 비교로 감지). */
let measuredFont = "";
let spacePx = 0;
function ensureSpaceWidth(view: EditorView): void {
  const font = `${getComputedStyle(view.contentDOM).font}`;
  if (font === measuredFont && spacePx > 0) return;
  const span = document.createElement("span");
  span.textContent = " ".repeat(20);
  span.style.whiteSpace = "pre";
  view.contentDOM.appendChild(span);
  const w = span.getBoundingClientRect().width / 20;
  span.remove();
  if (w > 0) {
    spacePx = w;
    measuredFont = font;
    view.contentDOM.style.setProperty("--md-space-px", `${w.toFixed(3)}px`);
  }
}

/** 뷰포트 보이는 줄의 선행 공백에 가이드 마크. */
function buildGuides(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const state = view.state;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      const spaces = /^ */.exec(line.text)![0].length;
      if (spaces >= 2 && !insideCode(state, line.from + 1)) {
        builder.add(
          line.from,
          line.from + spaces,
          Decoration.mark({ class: "md-indent-guide" }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** 들여쓰기 가이드 확장 — 편집·소스 모드에서만(읽기 모드 장식과 겹치지 않게).
 *  인스턴스를 그대로 노출해 테스트가 장식을 읽게 한다. */
export const indentGuidePlugin = ViewPlugin.fromClass(
  class {
    guides: DecorationSet;
    constructor(view: EditorView) {
      this.guides = this.build(view);
    }
    update(u: ViewUpdate) {
      // 트리 신원 변화(비동기 파싱 진행)도 반영 — 초기 부분 트리에서 코드펜스
      // 미인식으로 가이드가 생기는 것을 방지한다.
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.guides = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      if (view.state.facet(previewBehavior) === "render") return Decoration.none;
      ensureSpaceWidth(view);
      return buildGuides(view);
    }
  },
  { decorations: (v) => v.guides },
);
