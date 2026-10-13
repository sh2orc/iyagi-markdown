// 같은 단어 강조 — 커서가 놓인 단어의 문서 내 모든 발생을 옅게 표시
// (Word·VS Code의 occurrence highlighting). 뷰포트 줄만 스캔해 O(뷰포트).

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { Extension, Range } from "@codemirror/state";

/** 커서 위치의 단어(글자 연속) — 강조할 가치가 있는 것만. 순수 함수. */
export function wordAt(text: string, pos: number): string {
  const chars = Array.from(text);
  let start = pos;
  let end = pos;
  const isWord = (c: string | undefined): boolean => !!c && /\p{L}|\p{N}|_/u.test(c);
  while (start > 0 && isWord(chars[start - 1])) start--;
  while (end < chars.length && isWord(chars[end])) end++;
  const word = chars.slice(start, end).join("");
  // 너무 짧거나(관사 잡음) 숫자만: 가치 없음.
  if (word.length < 3 || /^\d+$/.test(word)) return "";
  return word;
}

/** 한 줄 안의 단어 경계 일치 위치들(대소문자 무시). 순수 함수. */
export function matchPositionsInLine(line: string, word: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const lower = line.toLowerCase();
  const target = word.toLowerCase();
  // 경계는 라틴 단어 문자에만 엄격 — 한글은 교착어라 조사가 붙은 형태
  // (문서→문서를·문서의)도 같은 단어로 잡는다.
  const isLatinWord = (c: string | undefined): boolean => !!c && /[A-Za-z0-9_]/.test(c);
  let i = 0;
  while (i <= lower.length - target.length) {
    const hit = lower.indexOf(target, i);
    if (hit === -1) break;
    const after = hit + target.length;
    const beforeOk = hit === 0 || !isLatinWord(line[hit - 1]);
    const afterOk = after >= line.length || !isLatinWord(line[after]);
    if (beforeOk && afterOk) {
      out.push([hit, after]);
      i = after;
    } else {
      i = hit + 1;
    }
  }
  return out;
}

const MAX_MARKS = 300;

/** 확장 — 커서 단어의 뷰포트 발생 표시(선택 중엔 끔 — 선택 강조와 충돌 방지). */
export function occurrenceHighlight(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      constructor(readonly view: EditorView) {
        this.rebuild();
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.rebuild();
      }
      rebuild(): void {
        const { state } = this.view;
        const sel = state.selection.main;
        if (!sel.empty) {
          this.decorations = Decoration.none;
          return;
        }
        const line = state.doc.lineAt(sel.head);
        const word = wordAt(line.text, sel.head - line.from);
        if (!word) {
          this.decorations = Decoration.none;
          return;
        }
        const ranges: Array<Range<Decoration>> = [];
        const dec = Decoration.mark({ class: "md-occurrence" });
        outer: for (const { from, to } of this.view.visibleRanges) {
          for (let l = state.doc.lineAt(from).number; l <= state.doc.lineAt(to).number; l++) {
            const ln = state.doc.line(l);
            for (const [a, b] of matchPositionsInLine(ln.text, word)) {
              ranges.push(dec.range(ln.from + a, ln.from + b));
              if (ranges.length >= MAX_MARKS) break outer;
            }
          }
        }
        this.decorations = ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
      }
    },
    { decorations: (v) => v.decorations },
  );
}
