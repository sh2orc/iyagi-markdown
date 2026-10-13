// 타이프라이터 스크롤 + 포커스 모드 — 장문 집중 집필 지원(Typora·iA Writer).
// 타이프라이터: 문서가 바뀌는 입력에만 커서 줄을 뷰포트 세로 중앙으로 맞춘다.
//   마우스 클릭·커서 이동으로는 스크롤하지 않는다(불쾌한 점프 방지).
// 포커스: 커서가 속한 최상위 블록 외에 흐림 마크(블록 사이 빈 줄에서는 해제).
// 둘 다 읽기 모드에선 비활성(커서도 입력도 없다).

import { Compartment, Facet, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";

export interface WritingConf {
  typewriter: boolean;
  focus: boolean;
  /** 문장 단위 포커스(iA Writer) — focus가 켜일 때만 의미 있다. */
  sentence: boolean;
  /** 읽기 모드면 false — 커서·입력이 없어 두 기능 모두 무의미. */
  active: boolean;
}

export const writingComp = new Compartment();

/** 맞춤법 검사 컴파트먼트 — contentAttributes(spellcheck) 재구성. */
export const spellcheckComp = new Compartment();

export function spellcheckExtension(): Extension {
  return EditorView.contentAttributes.of({ spellcheck: "true" });
}

export const writingConf = Facet.define<WritingConf, WritingConf>({
  combine: (vals) =>
    vals[vals.length - 1] ?? { typewriter: false, focus: false, sentence: false, active: true },
});

const dimMark = Decoration.mark({ class: "cm-focus-dim" });

/** 커서가 속한 최상위 블록을 제외한 나머지 블록 범위(흐림 대상).
 *  순수 함수 — lezer 트리만 받아 단위 테스트한다.
 *  커서가 블록 사이 간격(빈 줄)에 있으면 빈 배열(전체 또렷하게). */
export function computeDimRanges(
  tree: Tree,
  pos: number,
  sentence = false,
  sliceText: (from: number, to: number) => string = () => "",
): Array<{ from: number; to: number }> {
  const children: SyntaxNode[] = [];
  let active: SyntaxNode | null = null;
  let c = tree.topNode.firstChild;
  while (c) {
    if (c.to > c.from) children.push(c);
    if (pos >= c.from && pos <= c.to) active = c;
    c = c.nextSibling;
  }
  if (!active) return [];
  if (children.length < 2 && !sentence) return [];
  const out = children.filter((n) => n !== active).map((n) => ({ from: n.from, to: n.to }));
  if (sentence) {
    // 활성 블록 안에서도 현재 문장 외에는 흐린다(iA Writer 문장 포커스).
    const blockText = sliceText(active.from, active.to);
    const rel = pos - active.from;
    for (const [a, b] of sentenceSpans(blockText)) {
      if (rel < a || rel > b) out.push({ from: active.from + a, to: active.from + b });
    }
  }
  return out;
}

/** 문장 경계 오프셋 목록(상대 좌표) — . ! ? 。！？+공백에서 끊는다.
 *  순수 함수(테스트 대상). 종결이 없으면 한 덩어리. */
export function sentenceSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const TERM = new Set(".!?。！？");
  let start = 0;
  let i = 0;
  for (; i < text.length; i++) {
    if (TERM.has(text[i])) {
      // 종결부 연속(?! 등)과 뒤따르는 공백까지 문장에 포함.
      while (i + 1 < text.length && TERM.has(text[i + 1])) i++;
      while (i + 1 < text.length && text[i + 1] === " ") i++;
      spans.push([start, i + 1]);
      start = i + 1;
    }
  }
  if (start < text.length) spans.push([start, text.length]);
  return spans.filter(([a, b]) => b > a);
}

/** 문장 길이 진단 — 분포 버킷(짧음·보통·김·아주 김)과 최장. 순수 함수.
 *  한국어 기준: 30자 미만 짧음, 30~59 보통, 60~99 김, 100+ 아주 김. */
export interface SentenceLengthStats {
  total: number;
  longest: number;
  /** [짧음, 보통, 김, 아주 김] 문장 수. */
  buckets: [number, number, number, number];
  /** 60자 이상 문장 수(가독성 경고 지표). */
  longCount: number;
}

export function sentenceLengthStats(text: string): SentenceLengthStats {
  const buckets: [number, number, number, number] = [0, 0, 0, 0];
  let longest = 0;
  for (const [a, b] of sentenceSpans(text)) {
    // 길이는 공백 제거 — 부피로 재는 경향 보정.
    const len = text.slice(a, b).replace(/\s+/g, "").length;
    if (len > longest) longest = len;
    if (len < 30) buckets[0]++;
    else if (len < 60) buckets[1]++;
    else if (len < 100) buckets[2]++;
    else buckets[3]++;
  }
  const longCount = buckets[2] + buckets[3];
  return { total: buckets[0] + buckets[1] + buckets[2] + buckets[3], longest, buckets, longCount };
}

export function writingExtension(conf: WritingConf): Extension {
  const exts: Extension[] = [writingConf.of(conf)];
  if (!conf.active) return exts;
  if (conf.typewriter) exts.push(typewriterExt);
  if (conf.focus) exts.push(focusExt);
  return exts;
}

/** 같은 설정의 재디스패치를 건너뛴다(7차 교훈 — 내용 비교 없는 재구성은
 *  라이브 프리뷰 캐시까지 태운다. 여기는 별렬 컴파트먼트라 영향 없지만
 *  불필요한 트랜잭션도 낭비). */
export function applyWriting(view: EditorView, conf: WritingConf): void {
  const cur = view.state.facet(writingConf);
  if (
    cur.typewriter === conf.typewriter &&
    cur.focus === conf.focus &&
    cur.sentence === conf.sentence &&
    cur.active === conf.active
  ) {
    return;
  }
  view.dispatch({ effects: writingComp.reconfigure(writingExtension(conf)) });
}

/** 커서가 있는 줄을 스크롤 컨테이너 세로 중앙으로 — scrollTop 직접 조작.
 *  (업데이트 진행 중 dispatch는 불가하므로 마이크로태스크에서 부른다.) */
export function centerCursorLine(view: EditorView): void {
  const coords = view.coordsAtPos(view.state.selection.main.head);
  if (!coords) return;
  const scroller = view.scrollDOM;
  const rect = scroller.getBoundingClientRect();
  const delta = (coords.top + coords.bottom) / 2 - (rect.top + rect.height / 2);
  if (Math.abs(delta) > 1) scroller.scrollTop += delta;
}

const typewriterExt = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  const pos = update.state.selection.main.head;
  queueMicrotask(() => {
    // 이미 커서가 다른 곳으로 움직였다면 무시(빠른 연속 입력 마지막만 반영).
    if (cursorMovedOn(update.view, pos)) return;
    if (update.view.hasFocus) centerCursorLine(update.view);
  });
});

function cursorMovedOn(view: EditorView, pos: number): boolean {
  return view.state.selection.main.head !== pos || !view.dom.isConnected;
}

const focusExt = ViewPlugin.fromClass(
  class FocusPlugin {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.geometryChanged) {
        this.decorations = this.build(u.view);
      } else {
        this.decorations = this.decorations.map(u.changes);
      }
    }
    build(view: EditorView): DecorationSet {
      // 조각 파싱 중이면 파싱된 접두만 — 완료되면 측정 갱신(geometryChanged)으로
      // 다시 온다(livePreview와 달리 여기는 가벼운 마크라 전체 재계산이 싸다).
      const conf = view.state.facet(writingConf);
      const ranges = computeDimRanges(
        syntaxTree(view.state),
        view.state.selection.main.head,
        conf.focus && conf.sentence,
        (a, b) => view.state.doc.sliceString(a, b),
      );
      return Decoration.set(ranges.map((r) => dimMark.range(r.from, r.to)));
    }
  },
  { decorations: (v) => v.decorations },
);
