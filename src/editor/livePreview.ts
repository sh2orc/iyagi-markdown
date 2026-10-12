// 라이브 프리뷰 장식(§4-1). 구문 트리는 표시용 읽기 전용 정보로만 쓴다.
//
// 성능 구조(§7 — 큰 문서·부드러운 스크롤):
//  - 문서를 블록 경계로 자른 "청크" 단위로 장식을 계산하고 결과를 캐시한다.
//    스크롤(뷰포트 이동)만으로 이미 계산된 청크를 다시 계산하지 않는다 —
//    스캔 창에 새로 들어온 청크만 증분으로 붙인다. 커서 이동은 선택이 걷친
//    청크만, 문서 편집·설정 변경은 캐시를 비우고 스캔 창부터 다시 계산한다.
//    (과거 구현은 트리 성장 게이트로 파싱이 끝난 문서의 갱신 자체가 막혀
//    커서 노출이 멈추고, 파싱 진행 중엔 프레임마다 전체 재계산이 돌아
//    스크롤이 뚝뚝 끊겼다.)
//  - 청크 경계 규칙: 경계는 항상 (필요시 재귀 분할된) 블록 경계에만 놓는다.
//    표·코드펜스·수식처럼 커서 노출(reveal) 단위가 되는 블록은 절대 쪼개지
//    않아 장식이 두 청크에 겹쳐 발급되지 않는다. List·Blockquote·ListItem
//    처럼 노출 규칙이 줄 단위인 컨테이너만 길면 자식 경계로 쪼갠다.
//  - 각 청크는 트리가 그 끝까지 파싱된 뒤에만 계산한다(부분 파싱된 블록의
//    장식이 어긋나지 않게). 파싱이 진행 중이면 타이머로 이어받는다.
//  - 한 갱신 주기의 계산량은 예산(BUILD_BUDGET_MS)으로 제한해 메인 스레드
//    프레임을 지킨다 — WKWebView의 스크롤 합성은 GPU에서 돌므로, 메인
//    스레드가 프레임 안에 돌아오면 스크롤은 자연히 부드러워진다.
//
// 커서/선택/IME 조합 중인 블록은 장식을 풀어 원문을 보여 준다(Obsidian 방식).
// 읽기 모드는 같은 장식을 항상 켠다.

import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { EditorState, Facet, Range, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { lexicallyClean, percentDecode } from "../links";
import { parseWikiLink, resolveWikiLink } from "./wiki";
import { mdTableKey } from "./tableKey";
import { phrases } from "../app/phrases";
import {
  BulletWidget,
  DiagramWidget,
  FrontMatterWidget,
  WikiLinkWidget,
  HRuleWidget,
  ImageWidget,
  MathWidget,
  SpacerWidget,
  TableWidget,
  TaskItemWidget,
} from "./widgets";

// — 설정 전달(문서 경로·이미지 정책·테마) —

export interface PreviewConfig {
  baseDir: string;
  remoteImages: boolean;
  showImages: boolean;
  theme: "light" | "dark";
  /** 이미지 표시 폭(원본 경로 → %) — 문서 스타일 사이드카. */
  imageWidths: Record<string, number>;
  /** 책갈피 줄 번호 — SQLite 사이드카. */
  bookmarks: number[];
  /** 표 표시 폭(시작 줄 번호 문자열 → 열 px) — 문서 스타일 사이드카. */
  tableWidths: Record<string, number[]>;
  /** 위키링크 인덱스(소문자 이름 → 경로들) — 워크스페이스 트리에서(store). */
  wikiIndex: Map<string, string[]>;
}

export const setPreviewConfig = StateEffect.define<PreviewConfig>();

export const previewConfigField = StateField.define<PreviewConfig>({
  create: () => ({
    baseDir: "",
    remoteImages: true,
    showImages: true,
    theme: "light",
    imageWidths: {},
    bookmarks: [],
    tableWidths: {},
    wikiIndex: new Map(),
  }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setPreviewConfig)) value = e.value;
    }
    return value;
  },
});

/** 두 프리뷰 설정이 내용까지 같은가(캐시 폐기 여부 판정용). */
function previewConfigEquals(a: PreviewConfig | undefined, b: PreviewConfig): boolean {
  if (!a) return false;
  if (
    a.baseDir !== b.baseDir ||
    a.remoteImages !== b.remoteImages ||
    a.showImages !== b.showImages ||
    a.theme !== b.theme
  ) {
    return false;
  }
  const ka = Object.keys(a.imageWidths);
  const kb = Object.keys(b.imageWidths);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (a.imageWidths[k] !== b.imageWidths[k]) return false;
  }
  // 책갈피 — 배열 내용이 다르면 다른 설정이다(줄 번호 오름차순 정렬 전제).
  if (a.bookmarks.length !== b.bookmarks.length) return false;
  for (let i = 0; i < a.bookmarks.length; i++) {
    if (a.bookmarks[i] !== b.bookmarks[i]) return false;
  }
  // 위키링크 인덱스 — 참조 비교(트리가 바뀔 때만 store가 새 인스턴스를 만든다).
  if (a.wikiIndex !== b.wikiIndex) return false;
  return true;
}

// — 모드: 읽기(항상 렌더) vs 편집(커서 줄 원문 노출) —

export type PreviewBehavior = "render" | "reveal";
export const previewBehavior = Facet.define<PreviewBehavior, PreviewBehavior>({
  combine: (values) => values[0] ?? "reveal",
});

/** 표 폭 저장 콜백 — App이 스토어와 연결(원문 불변 사이드카). */
export let tableWidthsSaveHandler:
  | ((lineNo: number, key: string, widths: number[]) => void)
  | null = null;
export function setTableWidthsSaveHandler(
  fn: ((lineNo: number, key: string, widths: number[]) => void) | null,
): void {
  tableWidthsSaveHandler = fn;
}

// — 장식 상태 필드 —
// 블록 장식(표·수식·다이어그램 위젯처럼 줄 높이를 바꾸는 것)은 ViewPlugin이
// 아니라 StateField에서 제공해야 한다(CM6 규칙). 플러그인은 계산만 하고
// 이펙트로 필드에 반영한다.

const setDecorations = StateEffect.define<DecorationSet>();

const decorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDecorations)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

// — 청크 계획 —

/** 청크 목표 크기(문자). */
const CHUNK_TARGET = 4_000;
/** 이보다 긴 컨테이너(List·Blockquote·ListItem)는 자식 경계로 쪼갠다. */
const CHUNK_MAX = 16_000;
/** 한 갱신 주기에서 청크 계산에 쓸 수 있는 예산(ms) — 남으면 타이머로 이어받는다. */
const BUILD_BUDGET_MS = 12;
/** 캐시로 유지할 청크 상한(초과하면 스캔 창 밖 청크를 정리한다). */
const KEEP_CHUNKS = 144;

/** 재귀 분할 대상 컨테이너 — 커서 노출 규칙(isRevealed/isTouched)이 블록
 *  전체가 아니라 줄·인라인 단위인 것만 넣는다(그래야 노출 결정이 청크 안에서
 *  닫히고, 캐시가 선택 이동에 대해 정확해진다). */
const SPLITTABLE = new Set(["BulletList", "OrderedList", "Blockquote", "ListItem"]);

/** 문서를 청크 경계(블록 끝 위치 목록, 오름차순)로 자른다. 청크 i의 범위는
 *  [i===0 ? 0 : ends[i-1], ends[i] ?? 문서 끝). 트리 끝(파싱 프론티어)을
 *  넘는 블록은 제외 — 트리가 자라도 계산은 같은 접두사에 이어 붙으므로
 *  청크 인덱스가 안정한다(캐시 키로 쓴다). */
function computeBoundaries(view: EditorView): { ends: number[] } {
  const tree = syntaxTree(view.state);
  const treeLen = tree.length;
  const ends: number[] = [];
  let cur = 0;
  const walk = (node: SyntaxNode): void => {
    if (node.to > treeLen) return; // 아직 파싱이 안 끝난 블록
    if (node.to - node.from > CHUNK_MAX && SPLITTABLE.has(node.name)) {
      for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
      return;
    }
    if (node.to - cur >= CHUNK_TARGET) {
      ends.push(node.to);
      cur = node.to;
    }
  };
  for (let child = tree.topNode.firstChild; child; child = child.nextSibling) walk(child);
  return { ends };
}

/** ends에서 pos가 속한 청크 인덱스(이진 탐색). */
function chunkIndexAt(ends: number[], pos: number): number {
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends[mid] > pos) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 장식을 계산할 범위.
 *  - 읽기 모드(render): 문서 전체를 한 번에(리더로서의 페이지 렌더. 상한 300k).
 *  - 편집 모드(reveal): 뷰포트 + 여유(§7 — 스크롤 직전에 위젯이 준비되게).
 *    청크 계산이 증분이라 아래 여유를 크게 잡아도 스크롤 프레임을 쓰지 않는다. */
function scanRange(view: EditorView): { from: number; to: number } {
  const docLen = view.state.doc.length;
  const behavior = view.state.facet(previewBehavior);
  if (behavior === "render") {
    return { from: 0, to: Math.min(docLen, 300_000) };
  }
  const from = Math.max(0, view.viewport.from - 3_000);
  const to = view.viewport.to > view.viewport.from
    ? Math.min(docLen, view.viewport.to + 12_000)
    : Math.min(docLen, 50_000);
  return { from, to };
}

// — 장식 빌더 —

const replace = Decoration.replace;

/** 불릿 글리프 — 깊이별(Word의 글머리 기호 갤러리 순서). */
const BULLET_GLYPHS = ["•", "◦", "▪", "·"];
const NO_RANGES: readonly { from: number; to: number }[] = [];

/** 한 청크 [chunkFrom, chunkTo)의 장식을 계산한다.
 *  노드의 장식은 그 노드가 시작하는 청크가 발급한다(경계 규칙 덕에 정확히 한
 *  번). 이전 청크에서 시작해 걸친 노드는 내려만 간다. */
function buildChunk(view: EditorView, chunkFrom: number, chunkTo: number): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const behavior = view.state.facet(previewBehavior);
  const config = view.state.field(previewConfigField);
  const { baseDir, remoteImages, showImages, theme, imageWidths, bookmarks, tableWidths } = config;

  // 노출할 줄 = 편집 모드에서 커서·선택(·조합)이 걸친 줄.
  const revealed = new Set<number>();
  let revMin = Infinity;
  let revMax = -1;
  if (behavior === "reveal") {
    const sel = view.state.selection;
    for (const range of sel.ranges) {
      const from = doc.lineAt(range.from).number;
      const to = doc.lineAt(range.to).number;
      for (let n = from; n <= to; n++) revealed.add(n);
    }
    if (view.composing && sel.main.head === sel.main.to) {
      // 조합 중 — 캐럿 줄 확실히 노출.
      revealed.add(doc.lineAt(sel.main.head).number);
    }
    for (const n of revealed) {
      if (n < revMin) revMin = n;
      if (n > revMax) revMax = n;
    }
  }
  const isRevealed = (from: number, to: number): boolean => {
    if (revealed.size === 0) return false;
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    if (last < revMin || first > revMax) return false;
    for (let n = Math.max(first, revMin); n <= Math.min(last, revMax); n++) {
      if (revealed.has(n)) return true;
    }
    return false;
  };

  // 인라인 요소(**…**·`…`·링크 등)는 커서·선택이 **그 스팬 자체**(±1자)에
  // 닿을 때만 원문을 노출한다(Typora 모델). 줄 단위 노출보다 정교해 편집 중에도
  // Word처럼 보인다 — 같은 줄을 편집해도 볼드 마커는 숨겨진 채로 유지된다.
  const selRanges = behavior === "reveal" ? view.state.selection.ranges : NO_RANGES;
  const isTouched = (from: number, to: number): boolean =>
    selRanges.some((r) => from <= r.to + 1 && to >= r.from - 1);

  const addLineClasses = (from: number, to: number, cls: string, skipFirst = false) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) {
      if (skipFirst && n === first) continue;
      const line = doc.line(n);
      ranges.push(Decoration.line({ class: cls }).range(line.from));
    }
  };

  const absPath = (src: string): string => {
    if (/^(https?:|data:|file:|#)/i.test(src)) return src;
    const decoded = percentDecode(src).replace(/\\/g, "/");
    if (decoded.startsWith("/")) return lexicallyClean(decoded);
    return lexicallyClean(`${baseDir}/${decoded}`);
  };

  // 청크 창만 slice한다 — 문서 전체 toString은 큰 문서에서 프레임을 태운다.
  const slice = (from: number, to: number): string => doc.sliceString(from, to);
  const codeRanges: [number, number][] = [];

  try {
    syntaxTree(view.state).iterate({
      from: chunkFrom,
      to: chunkTo,
      enter: (ref) => {
        try {
          const node = ref.node;
          if (node.from < chunkFrom) {
            // 이전 청크에서 시작해 걸친 노드 — 장식은 시작 청크가 이미 넣었다.
            // 걸친 코드 블록의 범위만 물려받는다(아래 빈 줄 처리용).
            if (node.name === "FencedCode" || node.name === "CodeBlock") {
              codeRanges.push([node.from, node.to]);
            }
            return undefined;
          }
          return enterNode(node) ?? undefined;
        } catch (e) {
          // 한 요소의 실패가 문서 전체 렌더를 무너뜨리지 않게 한다.
          console.warn("livePreview: 노드 장식 실패", ref.node.name, e);
          return undefined;
        }
      },
    });
    // 해시태그 마크(#태그) — 청크 창 안에서 인식(제목/코드펜스 규칙은
    // extractTags와 같은 정규식으로 여기선 간단히: 경계 + # + 태그문자).
    {
      const firstLineNo2 = doc.lineAt(chunkFrom).number;
      const lastLineNo2 = doc.lineAt(Math.min(chunkTo, doc.length)).number;
      const inCode = (from: number) => codeRanges.some(([cf, ct]) => from >= cf && from <= ct);
      for (let n = firstLineNo2; n <= lastLineNo2; n++) {
        const line = doc.line(n);
        if (/^\s*(```|~~~)/.test(line.text)) continue; // 펜스 줄 자체
        const re = /(^|\s)(#[\p{L}\p{N}_\-\/]+)/gu;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line.text))) {
          const name = m[2].slice(1);
          if (/^\p{N}/u.test(name)) continue;
          if (/^#{1,6}\s/.test(line.text) && m.index === 0) continue; // ATX 제목 표시
          const from = line.from + m.index + m[1].length;
          const to = from + m[2].length;
          if (inCode(from)) continue;
          ranges.push(Decoration.mark({ class: "md-tag" }).range(from, to));
        }
      }
    }
    // 책갈피 줄 장식 — 청크 창 안의 줄만(별 배지 + 왼쪽 강조선).
    for (const bm of bookmarks) {
      const line = doc.line(Math.min(Math.max(bm, 1), doc.lines));
      if (line.from >= chunkFrom && line.from < chunkTo) {
        ranges.push(Decoration.line({ class: "md-bookmark" }).range(line.from));
      }
    }
    // 빈 줄은 낮게 — 블록 사이가 오밀조밀 붙게(불렛↔표 등). 코드 블록 안은 제외.
    // 청크 창의 줄만: 경계가 줄 중간이면(원자 블록이 창보다 길 때) 다음 줄부터.
    let n = doc.lineAt(chunkFrom).number;
    if (doc.line(n).from < chunkFrom) n++;
    for (; n <= doc.lines; n++) {
      const line = doc.line(n);
      if (line.from >= chunkTo) break;
      if (line.length !== 0) continue;
      if (codeRanges.some(([cf, ct]) => line.from >= cf && line.from <= ct)) continue;
      ranges.push(Decoration.line({ class: "md-blank" }).range(line.from));
    }
    function enterNode(node: SyntaxNode): boolean | undefined {
        const name = node.name;
        const from = node.from;
        const to = node.to;

        // — 제목 —
        const heading = /^(ATX|Setext)Heading([1-6])$/.exec(name);
        if (heading) {
          const level = heading[2];
          addLineClasses(from, to, `md-h${level}`);
          if (heading[1] === "ATX") {
            const mark = node.firstChild;
            if (mark && mark.name === "HeaderMark") {
              // #들과 그 뒤 공백 하나까지 지운다.
              const hideTo = Math.min(
                mark.to + 1 <= to && slice(mark.to, mark.to + 1) === " " ? mark.to + 1 : mark.to,
                to,
              );
              if (!isRevealed(from, to)) {
                ranges.push(replace({}).range(mark.from, hideTo));
              }
            }
          } else {
            // Setext: 밑줄(===/---) 줄을 접는다.
            if (!isRevealed(from, to)) {
              const lastLine = doc.lineAt(to);
              if (lastLine.from > from) {
                ranges.push(replace({}).range(lastLine.from, to));
                ranges.push(Decoration.line({ class: "md-setext-underline" }).range(lastLine.from));
              }
            }
          }
          return;
        }

        // — 문단(간격 리듬) —
        if (name === "Paragraph") {
          addLineClasses(from, to, "md-para");
          return;
        }

        // — 강조 —
        if (name === "Emphasis" || name === "StrongEmphasis") {
          if (isTouched(from, to)) return;
          const cls = name === "StrongEmphasis" ? "md-strong" : "md-em";
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === "EmphasisMark" || child.name === "StrongEmphasisMark") {
              ranges.push(replace({}).range(child.from, child.to));
            }
          }
          const first = node.firstChild;
          const last = node.lastChild;
          const contentFrom = first && first.name.endsWith("Mark") ? first.to : from;
          const contentTo = last && last.name.endsWith("Mark") ? last.from : to;
          if (contentTo > contentFrom) {
            ranges.push(Decoration.mark({ class: cls }).range(contentFrom, contentTo));
          }
          return;
        }

        // — 취소선 —
        if (name === "Strikethrough") {
          if (isTouched(from, to)) return;
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === "StrikethroughMark") {
              ranges.push(replace({}).range(child.from, child.to));
            }
          }
          const first = node.firstChild;
          const last = node.lastChild;
          const cFrom = first && first.name === "StrikethroughMark" ? first.to : from;
          const cTo = last && last.name === "StrikethroughMark" ? last.from : to;
          if (cTo > cFrom) {
            ranges.push(Decoration.mark({ class: "md-strike" }).range(cFrom, cTo));
          }
          return;
        }

        // — 인라인 코드 —
        if (name === "InlineCode") {
          if (isTouched(from, to)) return;
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === "CodeMark") ranges.push(replace({}).range(child.from, child.to));
          }
          const first = node.firstChild;
          const last = node.lastChild;
          const cFrom = first && first.name === "CodeMark" ? first.to : from;
          const cTo = last && last.name === "CodeMark" ? last.from : to;
          if (cTo > cFrom) {
            ranges.push(Decoration.mark({ class: "md-codeinline" }).range(cFrom, cTo));
          }
          return;
        }

        // — 링크·이미지(원문 정규식 기반 — 자식 구조 규격에 의존하지 않는다) —
        if (name === "Link" || name === "Image") {
          if (isTouched(from, to)) return;
          const text = slice(from, to);
          if (name === "Image") {
            // 이미지 단독 줄이면 가운데 크게, 아니면 인라인 작게.
            if (doc.lineAt(from).text.trim().startsWith("!")) {
              addLineClasses(from, from, "md-img-line");
            }
            const m = /^!\[([^\]]*)\]\(\s*<?([^)>]*?)>?((?:\s+"[^"]*")?)\s*\)$/.exec(text);
            if (m) {
              const src2 = absPath(m[2].trim());
              const w: WidgetType = new ImageWidget(
                src2,
                m[1],
                m[3]?.trim().replace(/^"|"$/g, "") || null,
                { remoteImages, showImages },
                imageWidths[src2],
              );
              ranges.push(replace({ widget: w, block: false }).range(from, to));
            }
            return;
          }
          const inline = /^\[([\s\S]*)\]\(\s*<?([^)>]*?)>?((?:\s+"[^"]*")?)\s*\)$/.exec(text);
          if (inline) {
            // 여는 "["와 닫는 "](url)"을 지우고 라벨만 링크처럼 보이게.
            const labelEnd = from + 1 + inline[1].length;
            ranges.push(replace({}).range(from, from + 1));
            ranges.push(replace({}).range(labelEnd, to));
            if (labelEnd > from + 1) {
              ranges.push(Decoration.mark({ class: "md-link", attributes: { title: `${phrases.linkOpen}: ${inline[2]}` } }).range(from + 1, labelEnd));
            }
            return;
          }
          // 참조 링크 [label][ref] — 라벨만 남긴다.
          const ref = /^\[([\s\S]*)\]\[([^\]]*)\]$/.exec(text);
          if (ref) {
            const labelEnd = from + 1 + ref[1].length;
            ranges.push(replace({}).range(from, from + 1));
            ranges.push(replace({}).range(labelEnd, to));
            ranges.push(Decoration.mark({ class: "md-link-ref" }).range(from + 1, labelEnd));
          }
          return;
        }

        // — 각주 정의 블록(문서 끝 영역) —
        if (name === "FootnoteDef") {
          addLineClasses(from, to, "md-footnote-def");
          return;
        }

        // — 하이라이트 ==텍스트==(커스텀 문법) —
        if (name === "Highlight") {
          ranges.push(Decoration.mark({ class: "md-highlight" }).range(from, to));
          return;
        }

        // — 위키링크 [[이름]](커스텀 문법) —
        if (name === "WikiLink") {
          const raw = slice(from, to);
          const { name: target, anchor, display } = parseWikiLink(raw);
          const resolved = resolveWikiLink(target, baseDir, config.wikiIndex);
          if (isRevealed(from, to)) return; // 원문 그대로
          ranges.push(
            replace({
              widget: new WikiLinkWidget(display ?? target, resolved, anchor),
            }).range(from, to),
          );
          return;
        }

        // — 각주 참조 [^label]: 위첨자 —
        if (name === "FootnoteRef") {
          if (isTouched(from, to)) return;
          ranges.push(
            Decoration.mark({ class: "md-footnote-ref", attributes: { title: slice(from, to) } }).range(from, to),
          );
          return;
        }

        // — URL·자동 링크 —
        if (name === "URL" || name === "Autolink") {
          ranges.push(Decoration.mark({ class: "md-url" }).range(from, to));
          return;
        }

        // — 코드 블록 —
        if (name === "FencedCode") {
          addLineClasses(from, to, "md-codeblock");
          const firstLine = doc.lineAt(from);
          const lastLine = doc.lineAt(to);
          ranges.push(Decoration.line({ class: "md-code-first" }).range(firstLine.from));
          ranges.push(
            Decoration.line({ class: "md-code-last" }).range(
              lastLine.from > firstLine.from ? lastLine.from : firstLine.from,
            ),
          );
          codeRanges.push([from, to]);
          if (isRevealed(from, to)) return;
          // FencedCode 자식: CodeMark(펜스) → CodeInfo(언어) → CodeText → CodeMark.
          const second = node.firstChild?.nextSibling;
          const info =
            second && second.name === "CodeInfo" ? slice(second.from, second.to).trim() : "";
          if (info === "mermaid") {
            const code = extractFenceBody(slice(from, to));
            ranges.push(
              replace({ widget: new DiagramWidget(code, theme), block: true }).range(from, to),
            );
            return;
          }
          // 펜스 줄은 얇게 접는다(둥근 모서리·안쪽 여백은 줄 클래스가 담당).
          ranges.push(replace({ widget: new SpacerWidget(2) }).range(firstLine.from, firstLine.to));
          const lastTrim = lastLine.text.trim();
          if (
            lastLine.from > firstLine.from &&
            (lastTrim.startsWith("```") || lastTrim.startsWith("~~~"))
          ) {
            ranges.push(replace({ widget: new SpacerWidget(2) }).range(lastLine.from, lastLine.to));
          }
          return;
        }
        if (name === "CodeBlock") {
          addLineClasses(from, to, "md-codeblock md-codeblock-indented");
          return;
        }

        // — 인용 —
        if (name === "Blockquote") {
          addLineClasses(from, to, "md-quote");
          return;
        }
        if (name === "QuoteMark") {
          if (!isRevealed(from, to)) ranges.push(replace({ class: "md-quotemark" }).range(from, to));
          return;
        }

        // — 목록 항목 —
        if (name === "ListItem") {
          const line = doc.lineAt(from);
          const indent = from - line.from;
          const depth = Math.min(6, Math.floor(indent / 2));
          addLineClasses(from, from, depth > 0 ? `md-li md-depth-${depth}` : "md-li");
          // 선행 공백은 시각 들여쓰기가 대체(원문은 불변 — 커서 줄은 원문 유지).
          // 노출 판정은 항목 시작 줄만 본다 — 항목 전체 범위로 보면 커서가 다른
          // 청크의 이어지는 줄에 있을 때 시작 청크 캐시가 못 따라간다.
          if (indent > 0 && !isRevealed(from, line.to)) {
            ranges.push(replace({}).range(line.from, from));
          }
          return;
        }

        // — 목록 —
        if (name === "ListMark") {
          const mark = slice(from, to);
          const isBullet = mark === "-" || mark === "*" || mark === "+";
          // 불릿(- * +)은 Word처럼 글리프로 표시 — 깊이별 • ◦ ▪ ·.
          // 번호 목록(1. / 1))은 원문 그대로 강조만. 커서가 닿으면 원문 노출.
          if (isBullet && !isTouched(from, to)) {
            const line = doc.lineAt(from);
            const depth = Math.min(3, Math.floor((from - line.from) / 2));
            const glyph = BULLET_GLYPHS[depth] ?? "•";
            ranges.push(replace({ widget: new BulletWidget(glyph) }).range(from, to));
          } else {
            ranges.push(Decoration.mark({ class: "md-listmark" }).range(from, to));
          }
          return;
        }
        if (name === "TaskMarker") {
          addLineClasses(from, from, "md-task-line");
          if (isTouched(from, to)) return;
          const checked = slice(from, to).charCodeAt(1) === 120; // x
          ranges.push(
            replace({ widget: new TaskItemWidget(checked) }).range(from, to),
          );
          return;
        }

        // — 표(GFM) —
        if (name === "Table") {
          if (isRevealed(from, to)) return;
          const startLine = doc.lineAt(from).number;
          const key = mdTableKey(slice(from, to));
          // 헤더 키 우선 — 줄 번호 키(구 사이드카)는 폴백.
          const saved = tableWidths[key] ?? tableWidths[String(startLine)];
          ranges.push(
            replace({
              widget: new TableWidget(
                slice(from, to),
                saved,
                (widths) => tableWidthsSaveHandler?.(startLine, key, widths),
              ),
              block: true,
            }).range(from, to),
          );
          return;
        }

        // — 프론트매터(YAML 메타) —
        if (name === "FrontMatter") {
          addLineClasses(from, to, "md-frontmatter");
          if (isRevealed(from, to)) return;
          ranges.push(
            replace({ widget: new FrontMatterWidget(slice(from, to)), block: true }).range(from, to),
          );
          return;
        }

        // — 수평선 —
        if (name === "HorizontalRule") {
          if (isRevealed(from, to)) return;
          ranges.push(replace({ widget: new HRuleWidget(), block: true }).range(from, to));
          return;
        }

        // — 수식(커스텀 문법) —
        if (name === "MathBlock") {
          if (isRevealed(from, to)) return;
          const latex = slice(from, to).replace(/^\$\$/, "").replace(/\$\$$/, "");
          ranges.push(
            replace({ widget: new MathWidget(latex, true), block: true }).range(from, to),
          );
          return;
        }
        if (name === "InlineMath") {
          if (isTouched(from, to)) return;
          const latex = slice(from + 1, to - 1);
          ranges.push(replace({ widget: new MathWidget(latex, false) }).range(from, to));
          return;
        }

        // — HTML 조각: 원문 유지, 회색 표시만(§4-2 3항) —
        if (name === "HTMLBlock" || name === "HTMLTag") {
          ranges.push(Decoration.mark({ class: "md-html" }).range(from, to));
          return;
        }
        return undefined;
    }
  } catch (e) {
    // 장식 실패는 표시를 원문으로 되돌릴 뿐 앱을 죽이지 않는다.
    console.error("livePreview 장식 실패", e);
  }

  __testing.stats.chunkBuilds++;
  __testing.stats.chars += chunkTo - chunkFrom;
  return ranges;
}

// — 갱신 플러그인 —
// 무엇이 바뀌었는지에 따라 최소한의 청크만 다시 계산한다:
//  - 스크롤(뷰포트 이동): 스캔 창에 새로 들어온 청크만 증분 계산. 창이 이미
//    덮인 범위 안이면 아무 것도 하지 않는다(스크롤 프레임 보호의 핵심).
//  - 커서/선택: 선택이 걷친(왔던·간) 줄의 청크만.
//  - 문서 편집·설정: 캐시 전체 폐기 후 스캔 창부터 재계산(예산제).
//  - 파싱 진행: 타이머로 이어받으며 프론티어 청크를 순차 붙인다.
const plugin = ViewPlugin.fromClass(
  class {
    private view: EditorView | null = null;
    private ends: number[] = [];
    private plannedTreeLen = -1;
    private chunks = new Map<number, Range<Decoration>[]>();
    private selFirst = 1;
    private selLast = 1;
    private queued = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(view: EditorView) {
      this.view = view;
      this.rememberSelection(view.state);
      // 뷰 구축 중에는 dispatch할 수 없으므로 직후 마이크로태스크로.
      this.schedule();
    }

    update(u: ViewUpdate) {
      // 설정 디스패치는 잦고 내용이 같을 때가 많다(모드 전환 재빌드 트리거,
      // 폰트 슬라이더 등 applyConfig 재실행) — 효과 신원이 아니라 내용이 실제로
      // 바뀐 경우에만 캐시를 버린다. 그렇지 않으면 슬라이더 한 번에 전체 재계산.
      const prevConfig = u.startState.field(previewConfigField, false);
      const configChanged = u.transactions.some((tr) =>
        tr.effects.some(
          (e) => e.is(setPreviewConfig) && !previewConfigEquals(prevConfig, e.value),
        ),
      );
      // 모드 전환(읽기↔편집)은 노출 규칙 자체가 바뀐다 — 장식을 전부 다시
      // 계산해야 한다(과거엔 같은 내용의 config 디스패치에 얹혀 있던 트리거).
      const behaviorChanged =
        u.startState.facet(previewBehavior) !== u.state.facet(previewBehavior);
      if (u.docChanged || configChanged || behaviorChanged) {
        // 문서 좌표·설정이 달라졌다 — 청크 계획과 캐시를 전부 폐기한다.
        this.ends = [];
        this.plannedTreeLen = -1;
        this.chunks.clear();
      }
      if (u.selectionSet) {
        const prevFirst = this.selFirst;
        const prevLast = this.selLast;
        this.rememberSelection(u.state);
        if (u.state.facet(previewBehavior) === "reveal") {
          // 읽기 모드의 장식은 선택과 무관하므로 편집 모드만.
          // 이전 커서 청크와 새 커서 청크 **각각만** 무효화한다 — 두 위치를
          // 잇는 범위를 통째로 무효화하면 건너뛰기 이동 한 번에 문서 전체
          // 재계산이 일어났다(29차 실측 1026%의 원인).
          this.invalidate(u.view, prevFirst, prevLast);
          this.invalidate(u.view, this.selFirst, this.selLast);
        }
      }
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || configChanged || behaviorChanged) {
        // 갱신 주기 안에서의 dispatch는 금지다("update is in progress" 크래시 —
        // 장식이 중간에 끊기는 원인). 마이크로태스크로 미루면 연속 갱신도 자연
        // 병합된다.
        this.schedule();
      }
    }

    destroy() {
      this.view = null;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    }

    private rememberSelection(state: EditorState) {
      let first = Infinity;
      let last = -1;
      for (const r of state.selection.ranges) {
        first = Math.min(first, state.doc.lineAt(r.from).number);
        last = Math.max(last, state.doc.lineAt(r.to).number);
      }
      this.selFirst = first === Infinity ? 1 : first;
      this.selLast = last === -1 ? state.doc.lines : last;
    }

    /** [firstLine, lastLine] 줄 범위가 걸친 청크를 다시 계산 대상으로 표시. */
    private invalidate(view: EditorView, firstLine: number, lastLine: number) {
      if (this.chunks.size === 0) return;
      const doc = view.state.doc;
      const from = doc.line(Math.max(1, Math.min(firstLine, doc.lines))).from;
      const to = doc.line(Math.max(1, Math.min(lastLine, doc.lines))).to;
      for (const idx of [...this.chunks.keys()]) {
        const s = idx === 0 ? 0 : this.ends[idx - 1];
        const e = this.ends[idx] ?? doc.length;
        if (e > from && s < to) this.chunks.delete(idx);
      }
    }

    private schedule() {
      if (this.queued) return;
      this.queued = true;
      queueMicrotask(() => {
        this.queued = false;
        this.run();
      });
    }

    /** 예산이 남은 계산·파싱 대기를 타이머로 이어받는다(가장 이른 예약 하나). */
    private later(ms: number) {
      if (this.timer !== null) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.run();
      }, ms);
    }

    private run() {
      const view = this.view;
      // destroy된 뷰는 dom이 떨어져 나간다(destroyed는 private이라 간접 확인).
      if (!view || !view.dom.isConnected) return;
      const docLen = view.state.doc.length;
      const treeLen = syntaxTree(view.state).length;
      if (treeLen !== this.plannedTreeLen) {
        // 접두사가 안정하므로 통째로 다시 계산해도 캐시 키(인덱스)는 그대로.
        this.ends = computeBoundaries(view).ends;
        this.plannedTreeLen = treeLen;
      }
      const scan = scanRange(view);
      const t0 = performance.now();
      let builtAny = false;
      let budgetLeft = true;
      let waitingParse = false;
      for (let i = chunkIndexAt(this.ends, scan.from); i <= this.ends.length; i++) {
        const s = i === 0 ? 0 : this.ends[i - 1];
        if (s >= scan.to) break;
        const e = this.ends[i] ?? docLen;
        if (e > treeLen && treeLen < docLen) {
          // 아직 파싱이 안 온 청크 — 타이머로 재조회한다.
          waitingParse = true;
          continue;
        }
        if (this.chunks.has(i)) continue;
        this.chunks.set(i, buildChunk(view, s, e));
        builtAny = true;
        if (performance.now() - t0 > BUILD_BUDGET_MS) {
          budgetLeft = false;
          break;
        }
      }
      if (builtAny) {
        this.prune(view, scan);
        const keys = [...this.chunks.keys()].sort((a, b) => a - b);
        const all: Range<Decoration>[] = [];
        for (const k of keys) all.push(...this.chunks.get(k)!);
        // 이 dispatch는 doc/선택을 바꾸지 않는다. 블록 위젯으로 뷰포트가 다시
        // 잡히면 update가 오지만 창 청크는 이미 차 있어 재디스패치로 이어지지
        // 않는다.
        view.dispatch({ effects: setDecorations.of(Decoration.set(all, true)) });
        __testing.stats.dispatches++;
      }
      if (!budgetLeft) this.later(30);
      else if (waitingParse) this.later(70);
    }

    /** 캐시 상한을 넘으면 스캔 창에서 먼 청크를 버린다(다시 오면 재계산). */
    private prune(view: EditorView, scan: { from: number; to: number }) {
      if (this.chunks.size <= KEEP_CHUNKS) return;
      const docLen = view.state.doc.length;
      const lo = scan.from - 64_000;
      const hi = scan.to + 64_000;
      for (const idx of [...this.chunks.keys()]) {
        const s = idx === 0 ? 0 : this.ends[idx - 1];
        const e = this.ends[idx] ?? docLen;
        if (e < lo || s > hi) this.chunks.delete(idx);
      }
    }
  },
);

export function livePreviewExtension(): Extension {
  return [decorationField, plugin];
}

/** (테스트·디버그) 현재 스캔 창의 장식을 동기로 한 번에 계산한다. */
function buildDecorations(view: EditorView): DecorationSet {
  const scan = scanRange(view);
  const doc = view.state.doc;
  const treeLen = syntaxTree(view.state).length;
  const { ends } = computeBoundaries(view);
  const all: Range<Decoration>[] = [];
  for (let i = chunkIndexAt(ends, scan.from); i <= ends.length; i++) {
    const s = i === 0 ? 0 : ends[i - 1];
    if (s >= scan.to) break;
    const e = ends[i] ?? doc.length;
    if (e > treeLen && treeLen < doc.length) continue; // 아직 파싱 안 됨
    all.push(...buildChunk(view, s, e));
  }
  return Decoration.set(all, true);
}

/** 펜스 코드 블록의 본문(펜스 줄 제외)을 뽑는다. */
function extractFenceBody(text: string): string {
  let s = text;
  s = s.replace(/^[`~]+[^\n]*\n?/, "");
  s = s.replace(/\n?[`~]+$/, "");
  return s;
}

/** 클릭 위치의 링크 정보(내부 열기/외부 열기 분류는 links.ts가).
 *  text는 표시 텍스트(링크 편집 대화상자용). */
export function findLinkAt(
  state: EditorState,
  pos: number,
): { url: string; text: string; from: number; to: number } | null {
  let found: { url: string; text: string; from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: Math.max(0, pos - 2000),
    to: Math.min(state.doc.length, pos + 2000),
    enter: (node) => {
      if (found) return false;
      if (node.name === "Link" && pos >= node.from && pos <= node.to) {
        const raw = state.doc.sliceString(node.from, node.to);
        const m = /^\[([\s\S]*)\]\(\s*<?([^)>]*?)>?\s*\)$/.exec(raw);
        if (m) {
          found = { url: m[2], text: m[1], from: node.from, to: node.to };
          return false;
        }
      }
      return;
    },
  });
  return found;
}

/** 테스트 전용 내부 노출. */
export const __testing = {
  decorationField: decorationField,
  buildDecorations,
  computeBoundaries,
  stats: { chunkBuilds: 0, chars: 0, dispatches: 0 },
  resetStats(): void {
    __testing.stats.chunkBuilds = 0;
    __testing.stats.chars = 0;
    __testing.stats.dispatches = 0;
  },
};
