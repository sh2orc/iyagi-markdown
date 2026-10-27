// 변경 추적(Word Track Changes의 마크다운 판) — 베이스라인 스냅숏과의
// 줄 diff로 현재 문서의 추가·수정 라인을 표시. 삭제는 리뷰 패널/개수로.
// 순수 계산 + 뷰포트 장식 플러그인.

import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { phrases } from "../app/phrases";

import { diffLines } from "./diff";

/** 베이스라인 대비 바뀐 줄 번호들(1-기준, 현재 문서 좌표)·삭제 줄 수. 순수. */
export function changedLines(baseline: string, current: string): { added: Set<number>; removed: number } {
  if (baseline === current) return { added: new Set(), removed: 0 };
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
  (view: unknown): { id: string; baseline: string | null } | null;
}

let provider: TrackProvider | null = null;
export function setTrackProvider(fn: TrackProvider | null): void {
  provider = fn;
}


/** 삭제 블록 클릭 → 되돌리기 — App/스토어가 등록. */
type RevertHandler = (view: EditorView, doc: Text, baseline: string, hunk: TrackHunk, tabId: string) => void;
export let delRevertHandler: RevertHandler | null = null;
export function setDelRevertHandler(fn: RevertHandler | null): void {
  delRevertHandler = fn;
}

/** 삭제된 줄 표시 위젯 — 취소선 회색 블록(Word의 삭제 표시). */
class DelLinesWidget extends WidgetType {
  constructor(readonly lines: string[], readonly hunk: TrackHunk, readonly doc: Text, readonly baseline: string, readonly tabId: string, readonly readOnly: boolean) { super(); }
  eq(other: DelLinesWidget) {
    return other.readOnly === this.readOnly && other.tabId === this.tabId && other.doc === this.doc && other.baseline === this.baseline && other.hunk.line === this.hunk.line &&
      other.hunk.restore === this.hunk.restore;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "md-tracked-del";
    for (const line of this.lines) {
      const row = document.createElement("div"); row.textContent = line; wrap.append(row);
    }
    if (delRevertHandler) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "md-tracked-del-action";
      button.textContent = phrases.trackRestoreDeleted;
      button.disabled = this.readOnly;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => {
        event.preventDefault(); event.stopPropagation();
        delRevertHandler?.(view, this.doc, this.baseline, this.hunk, this.tabId);
      });
      wrap.append(button);
    }
    return wrap;
  }
  ignoreEvent() { return true; }
}

export const trackingChanged = StateEffect.define<void>();
const trackingDecorationsChanged = StateEffect.define<DecorationSet>();
// 블록 위젯은 직접 decorations facet을 제공하는 StateField에서 공급한다.
export const trackingDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    if (transaction.docChanged || transaction.effects.some((effect) => effect.is(trackingChanged))) return Decoration.none;
    for (const effect of transaction.effects) if (effect.is(trackingDecorationsChanged)) return effect.value;
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 확장 — 베이스라인 diff 추가 줄 장식(수정 표시, Word '변경 내용 표시'). */
export function trackChanges(): Extension {
  return [trackingDecorations, ViewPlugin.fromClass(
    class {
      private raf = 0;
      private cache: { doc: Text; baseline: string; hunks: TrackHunk[]; added: Set<number> } | null = null;
      constructor(readonly view: EditorView) {
        this.schedule();
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || u.startState.readOnly !== u.state.readOnly || u.transactions.some((tr) => tr.effects.some((effect) => effect.is(trackingChanged)))) this.schedule();
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
          this.cache = null;
          this.view.dispatch({ effects: trackingDecorationsChanged.of(Decoration.none) });
          return;
        }
        const doc = this.view.state.doc;
        if (!this.cache || this.cache.doc !== doc || this.cache.baseline !== p.baseline) {
          const hunks = hunksOf(p.baseline, doc.toString());
          const added = new Set<number>();
          for (const hunk of hunks) if (hunk.kind === "add") {
            for (let line = hunk.fromLine; line <= hunk.toLine; line++) added.add(line);
          }
          this.cache = { doc, baseline: p.baseline, hunks, added };
        }
        const { hunks, added } = this.cache;
        const ranges: Array<Range<Decoration>> = [];
        const lineDec = Decoration.line({ class: "md-tracked-add" });
        // 추가·수정 줄 — 라인 장식.
        for (const { from, to } of this.view.visibleRanges) {
          for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) {
            if (added.has(l)) ranges.push(lineDec.range(doc.line(l).from));
            if (ranges.length > 600) break;
          }
        }
        // 블록은 뷰포트와 무관하게 공급한다. 블록 높이로 뷰포트가 바뀔 때
        // 생성/제거를 반복하지 않으며 실제 DOM 가상화는 편집기에 맡긴다.
        let deletedWidgets = 0;
        for (const h of hunks) {
          if (h.kind !== "del") continue;
          if (deletedWidgets >= 700) break;
          const atEnd = h.line > doc.lines;
          const pos = atEnd ? doc.length : doc.line(h.line).from;
          const all = h.restore.split("\n");
          const lines = all.slice(0, 8);
          if (all.length > 8) lines.push(`… (${all.length - 8}줄 더 — 패널 참조)`);
          ranges.push(Decoration.widget({ widget: new DelLinesWidget(lines, h, doc, p.baseline, p.id, this.view.state.readOnly), block: true, side: atEnd ? 1 : -1 }).range(pos));
          deletedWidgets += 1;
        }
        this.view.dispatch({ effects: trackingDecorationsChanged.of(ranges.length > 0 ? Decoration.set(ranges, true) : Decoration.none) });
      }
      destroy(): void {
        if (this.raf) cancelAnimationFrame(this.raf);
      }
    },
  )];
}

/** 이전→새 텍스트 diff로 줄 번호 이동 보정 — 저장 시 메모·책갈피 재앵커.
 *  삭제된 범위의 줄은 0(버림 신호). 순수 함수(테스트 대상). */
export function shiftLineNo(lineNo: number, baseline: string, current: string): number {
  return shiftLineNumbers([lineNo], baseline, current)[0];
}

/** 여러 앵커를 한 번의 diff로 이동한다. 결과 순서와 중복은 입력을 따른다. */
export function shiftLineNumbers(lines: readonly number[], baseline: string, current: string): number[] {
  if (!lines.length) return [];
  if (baseline === current) {
    const last = current.split("\n").length;
    return lines.map((line) => Math.max(1, Math.min(line, last)));
  }
  const sorted = lines.map((line, index) => ({ line, index })).sort((a, b) => a.line - b.line);
  const result = new Array<number>(lines.length);
  let oldPos = 0, newPos = 0, next = 0;
  for (const op of diffLines(baseline, current)) {
    const count = op.text.split("\n").length;
    if (op.kind === "add") { newPos += count; continue; }
    while (next < sorted.length && sorted[next].line <= oldPos + count) {
      const target = sorted[next++];
      result[target.index] = op.kind === "same" ? newPos + target.line - oldPos : 0;
    }
    oldPos += count;
    if (op.kind === "same") newPos += count;
  }
  while (next < sorted.length) result[sorted[next++].index] = Math.max(1, newPos);
  return result;
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
  if (baseline === current) return [];
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


/** 줄 경계의 개행까지 포함한 단일 되돌리기 편집. */
export function revertChange(h: TrackHunk, lineText: (line: number) => { from: number; to: number }, docLines: number): { from: number; to: number; insert: string } | null {
  if (h.kind === "add") {
    if (h.toLine > docLines || h.fromLine < 1 || h.toLine < h.fromLine) return null;
    let from = lineText(h.fromLine).from;
    let to = lineText(h.toLine).to;
    if (h.toLine < docLines) to += 1;
    else if (h.fromLine > 1) from -= 1;
    return { from, to, insert: "" };
  }
  if (h.line < 1 || h.line > docLines + 1) return null;
  const append = h.line > docLines;
  const anchor = lineText(Math.min(h.line, docLines));
  const empty = docLines === 1 && anchor.from === 0 && anchor.to === 0;
  const from = append ? anchor.to : anchor.from;
  return { from, to: from, insert: append ? `\n${h.restore}` : empty ? h.restore : `${h.restore}\n` };
}
