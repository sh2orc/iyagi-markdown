// 변경 추적(Word Track Changes의 마크다운 판) — 베이스라인 스냅숏과의
// 줄 diff로 현재 문서의 추가·수정 라인을 표시. 삭제는 리뷰 패널/개수로.
// 순수 계산 + 뷰포트 장식 플러그인.

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { Extension, Range } from "@codemirror/state";

import { diffLines } from "./diff";

/** 베이스라인 대비 바뀐 줄 번호들(1-기준, 현재 문서 좌표)·삭제 줄 수. 순수. */
export function changedLines(baseline: string, current: string): { added: Set<number>; removed: number } {
  const ops = diffLines(baseline, current);
  const added = new Set<number>();
  let removed = 0;
  let line = 0;
  for (const op of ops) {
    if (op.kind === "same") {
      line += op.text.split("\n").length;
    } else if (op.kind === "add") {
      const n = op.text.split("\n").length;
      for (let i = 1; i <= n; i++) added.add(line + i);
      line += n;
    } else {
      removed += op.text.split("\n").length;
    }
  }
  return { added, removed };
}

export interface TrackProvider {
  (view: unknown): { baseline: string | null; current: string } | null;
}

let provider: TrackProvider | null = null;
export function setTrackProvider(fn: TrackProvider | null): void {
  provider = fn;
}

/** 확장 — 베이스라인 diff 추가 줄 장식(수정 표시, Word '변경 내용 표시'). */
export function trackChanges(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private raf = 0;
      constructor(readonly view: EditorView) {
        this.schedule();
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged) this.schedule();
      }
      schedule(): void {
        if (this.raf) return;
        this.raf = requestAnimationFrame(() => {
          this.raf = 0;
          this.rebuild();
        });
      }
      rebuild(): void {
        const p = provider?.(this.view);
        if (!p || p.baseline == null) {
          this.decorations = Decoration.none;
          return;
        }
        const { added } = changedLines(p.baseline, p.current);
        if (added.size === 0) {
          this.decorations = Decoration.none;
          return;
        }
        const dec = Decoration.line({ class: "md-tracked-add" });
        const ranges: Array<Range<Decoration>> = [];
        outer: for (const { from, to } of this.view.visibleRanges) {
          for (let l = this.view.state.doc.lineAt(from).number; l <= this.view.state.doc.lineAt(to).number; l++) {
            if (added.has(l)) {
              ranges.push(dec.range(this.view.state.doc.line(l).from));
              if (ranges.length > 500) break outer;
            }
          }
        }
        this.decorations = ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none;
      }
      destroy(): void {
        if (this.raf) cancelAnimationFrame(this.raf);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
