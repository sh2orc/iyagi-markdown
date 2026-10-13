// 변경 추적(Word Track Changes의 마크다운 판) — 베이스라인 스냅숏과의
// 줄 diff로 현재 문서의 추가·수정 라인을 표시. 삭제는 리뷰 패널/개수로.
// 순수 계산 + 뷰포트 장식 플러그인.

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
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


/** 삭제 블록 클릭 → 되돌리기 — App/스토어가 등록. */
export let delRevertHandler: ((hunk: TrackHunk) => void) | null = null;
export function setDelRevertHandler(fn: ((hunk: TrackHunk) => void) | null): void {
  delRevertHandler = fn;
}

/** 삭제된 줄 표시 위젯 — 취소선 회색 블록(Word의 삭제 표시). */
class DelLinesWidget extends WidgetType {
  constructor(readonly lines: string[], readonly hunk: TrackHunk | null) {
    super();
  }
  eq(other: DelLinesWidget) {
    return other.lines.join("\n") === this.lines.join("\n");
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "md-tracked-del";
    for (const l of this.lines) {
      const d = document.createElement("div");
      d.textContent = l;
      wrap.append(d);
    }
    if (this.hunk && delRevertHandler) {
      wrap.title = "클릭하여 이 삭제 되돌리기";
      wrap.classList.add("is-revertable");
      wrap.addEventListener("mousedown", (e) => {
        e.preventDefault();
        delRevertHandler?.(this.hunk!);
      });
    }
    return wrap;
  }
  ignoreEvent() {
    return false; // 클릭 되돌리기를 쓴다.
  }
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
        const hunks = hunksOf(p.baseline, p.current);
        const doc = this.view.state.doc;
        const ranges: Array<Range<Decoration>> = [];
        const lineDec = Decoration.line({ class: "md-tracked-add" });
        // 추가·수정 줄 — 라인 장식.
        for (const { from, to } of this.view.visibleRanges) {
          for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) {
            if (added.has(l)) ranges.push(lineDec.range(doc.line(l).from));
            if (ranges.length > 600) break;
          }
        }
        // 삭제 덩어리 — 그 위치에 취소선 블록 위젯(보이는 범위만).
        for (const h of hunks) {
          if (h.kind !== "del") continue;
          const target = Math.min(h.line, doc.lines);
          const pos = doc.line(target).from;
          if (!this.view.visibleRanges.some((r) => pos >= r.from - 40 && pos <= r.to + 40)) continue;
          const lines = h.restore.split("\n").slice(0, 8);
          ranges.push(Decoration.widget({ widget: new DelLinesWidget(lines, h), block: true, side: -1 }).range(pos));
          if (ranges.length > 700) break;
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

/** 이전→새 텍스트 diff로 줄 번호 이동 보정 — 저장 시 메모·책갈피 재앵커.
 *  삭제된 범위의 줄은 0(버림 신호). 순수 함수(테스트 대상). */
export function shiftLineNo(
  lineNo: number,
  baseline: string,
  current: string,
): number {
  const ops = diffLines(baseline, current);
  let oldPos = 0;
  let newPos = 0;
  for (const op of ops) {
    const n = op.text.split("\n").length;
    if (op.kind === "same") {
      // 이 블록 안의 줄은 같은 상대 위치로 매핑.
      if (lineNo <= oldPos + n) return newPos + (lineNo - oldPos);
      oldPos += n;
      newPos += n;
    } else if (op.kind === "del") {
      if (lineNo <= oldPos + n) return 0;
      oldPos += n;
    } else {
      newPos += n;
    }
  }
  return Math.max(1, lineNo > oldPos ? newPos : newPos);
}

export interface TrackHunk {
  kind: "add" | "del";
  line: number;
  lines: number;
  preview: string;
  fromLine: number;
  toLine: number;
  restore: string;
}

/** diff 연산 → 변경 덩어리 목록(현재 문서 줄 좌표). 순수 함수. */
export function hunksOf(baseline: string, current: string): TrackHunk[] {
  const ops = diffLines(baseline, current);
  const out: TrackHunk[] = [];
  let line = 0;
  for (const op of ops) {
    if (op.kind === "same") {
      line += op.text.split("\n").length;
    } else if (op.kind === "add") {
      const n = op.text.split("\n").length;
      out.push({
        kind: "add",
        line: line + 1,
        lines: n,
        preview: op.text.split("\n")[0] ?? "",
        fromLine: line + 1,
        toLine: line + n,
        restore: "",
      });
      line += n;
    } else {
      out.push({
        kind: "del",
        line: line + 1,
        lines: op.text.split("\n").length,
        preview: op.text.split("\n")[0] ?? "",
        fromLine: 0,
        toLine: 0,
        restore: op.text,
      });
    }
  }
  return out;
}
