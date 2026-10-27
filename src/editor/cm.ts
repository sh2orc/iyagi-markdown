// CodeMirror 확장 조립. 한 창에 EditorView 하나 — 탭 전환은 setState로
// 버퍼만 갈아끼운다(비활성 탭은 EditorState만 메모리에 남는다, §7).
//
// 모드(읽기/편집/소스)는 Compartment로 재구성한다: 같은 버퍼를 보는 세 가지
// "보기"일 뿐이므로 전환에 변환이 없다(§0 D4/D5).

import { searchKeymap, selectNextOccurrence } from "@codemirror/search";
import { addCursorAbove, addCursorBelow } from "./multiCursor";
import { looksLikeTsv, tsvToTable } from "./tsvTable";
import { trackChanges } from "./trackChanges";
import { copyFormat, pasteFormat } from "./formatPainter";
import { asyncEditPlugin, captureAsyncEdit } from "./asyncEdit";
import { clipboardNotice, pasteTextFromClipboard } from "./clipboard";
import { Compartment, EditorState, Extension, Prec } from "@codemirror/state";
import { crosshairCursor, EditorView, keymap, rectangularSelection, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  cursorLineDown,
  cursorLineUp,
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  selectLineDown,
  selectLineUp,
} from "@codemirror/commands";
import { GFM } from "@lezer/markdown";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { foldGutter, foldKeymap, foldService, indentUnit, syntaxTree } from "@codemirror/language";

/** 제목 접기 범위 — 헤딩 줄에서 같거나 낮은 단계의 다음 제목 전까지.
 *  순수 함수(테스트 대상). lang-markdown은 블록(표·코드)만 접어준다
 *  (제목·목록은 범위 계산이 필요해 제외됨) — 여기서 제목 범위를 채운다. */
export function headingFoldOf(
  state: EditorState,
  from: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(from);
  if (from !== line.from) return null;
  const m = /^(#{1,6})\s/.exec(line.text);
  if (!m) return null;
  const level = m[1].length;
  let end = line.to;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    const t = /^(#{1,6})\s/.exec(l.text);
    if (t && t[1].length <= level) break;
    end = l.to;
  }
  return end > line.to ? { from: line.to, to: end } : null;
}

/** 목록 항목 접기 범위 — 마커 줄에서 항목 끝(하위 항목 포함)까지.
 *  구문 트리의 ListItem 노드 범위를 그대로 쓴다. 순수 함수(테스트 대상). */
export function listItemFoldOf(
  state: EditorState,
  from: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(from);
  if (from !== line.from) return null;
  if (!/^\s*(?:[-*+]|\d+[.)])\s/.test(line.text)) return null;
  // from이 속한 ListItem 노드 — 트리에서 찾아 항목 전체 범위를 얻는다.
  let node: { name: string; to: number; parent: unknown } | null =
    syntaxTree(state).resolveInner(from, 1) as unknown as { name: string; to: number; parent: unknown } | null;
  while (node && node.name !== "ListItem") {
    node = (node.parent ?? null) as typeof node;
    if (node && node.name === "Document") return null;
  }
  if (!node) return null;
  const to = node.to;
  return to > line.to ? { from: line.to, to } : null;
}

/** 코드펜스 접기 범위 — 여는 \`\`\`/~~~ 줄에서 닫는 줄까지. 순수 함수. */
export function fenceFoldOf(
  state: EditorState,
  from: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(from);
  if (from !== line.from) return null;
  const m = /^(\s*)(\`\`\`|~~~)/.exec(line.text);
  if (!m) return null;
  const fence = m[2]!;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    if (l.text.trimStart().startsWith(fence)) {
      // 닫는 줄 전까지(닫는 줄은 펼침 상태에서도 보이게 — 제목 접기 관례).
      const prev = state.doc.line(n - 1);
      return prev.number > line.number ? { from: line.to, to: prev.to } : null;
    }
  }
  return null;
}

/** 인용 블록 접기 — 첫 > 줄에서 인용이 끝나는 줄까지. 순수 함수. */
export function quoteFoldOf(
  state: EditorState,
  from: number,
): { from: number; to: number } | null {
  const line = state.doc.lineAt(from);
  if (from !== line.from) return null;
  if (!/^>\s/.test(line.text)) return null;
  let end = line.to;
  for (let n = line.number + 1; n <= state.doc.lines; n++) {
    const l = state.doc.line(n);
    if (!/^>\s/.test(l.text)) break;
    end = l.to;
  }
  return end > line.to ? { from: line.to, to: end } : null;
}

const headingFoldService = foldService.of((state, from, to) => {
  void to;
  return (
    headingFoldOf(state, from) ??
    fenceFoldOf(state, from) ??
    quoteFoldOf(state, from) ??
    listItemFoldOf(state, from)
  );
});

import {
  blockWidgetRangesBetween,
  findLinkAt,
  isRevealableBlockWidget,
  livePreviewExtension,
  previewBehavior,
  previewConfigField,
  setPreviewConfig,
} from "./livePreview";
import { editorSyntaxHighlighting, editorTheme } from "./theme";
import { mathSyntax } from "./mathSyntax";
import { wikiAutocompletion } from "./wikiComplete";
import { frontMatterSyntax } from "./frontmatter";
import { wikiLinkSyntax } from "./wiki";
import {
  cachedLinkPreview,
  previewHtmlOf,
  previewTextOf,
  rememberLinkPreview,
  scheduleHideLinkPreview,
  showLinkPreview,
  footnoteDefinition,
} from "./linkPreview";

/** 위키 호버 머무름 타이머 — mouseout에서 취소(지나갈 때 팝오버 방지). */
let wikiHoverTimer: number | null = null;

/** 메모 제공자 — App이 스토어와 연결(호버 팝오버용). */
export type CommentEntry = { id: number; lineNo: number; text: string; resolved: boolean };
let commentsProvider: (() => CommentEntry[]) | null = null;
export function setCommentsProvider(fn: (() => CommentEntry[]) | null): void {
  commentsProvider = fn;
}
function clearWikiHoverTimer(): void {
  if (wikiHoverTimer !== null) {
    window.clearTimeout(wikiHoverTimer);
    wikiHoverTimer = null;
  }
}
import { htmlToMarkdown } from "./htmlPaste";
import { phrases } from "../app/phrases";
import { api, isInApp } from "../api";
import * as fmt from "./format";
import { resetSearch, searchHighlight } from "../search/searchCm";
import { writingComp, writingConf, writingExtension } from "./writing";
import { smartPunctComp, smartPunctExtension } from "./smartPunct";
import { indentGuidePlugin } from "./indentGuide";

/** 파이프 없는 텍스트 줄이 표 행(| 시작) 사이에 끼면 빈 줄로 분리한다.
 *  순수 텍스트 판정이라 트리 지연과 무관하게 즉시 동작(첫 글자에서 분리). */
function splitTableAtPlainLine(view: EditorView, u: import("@codemirror/view").ViewUpdate): void {
  const doc = u.state.doc;
  const seen = new Set<number>();
  u.changes.iterChangedRanges((fromA, toA) => {
    const first = doc.lineAt(fromA).number;
    const last = doc.lineAt(Math.min(toA, doc.length)).number;
    for (let n = first; n <= last; n++) seen.add(n);
  });
  // 변경 줄만 검사(성능 — 문서 전체 순회 안 함).
  for (const n of seen) {
    if (n < 1 || n > doc.lines) continue;
    const line = doc.line(n);
    const t = line.text;
    if (!t.trim() || /^\s*\|/.test(t)) continue; // 빈 줄·표 행은 대상 아님
    const prev = n > 1 ? doc.line(n - 1) : null;
    const next = n < doc.lines ? doc.line(n + 1) : null;
    const before = prev !== null && /^\s*\|/.test(prev.text);
    const after = next !== null && /^\s*\|/.test(next.text);
    if (!before && !after) continue;
    const insertBefore = before ? "\n" : "";
    const insertAfter = after ? "\n" : "";
    const head = view.state.selection.main.head;
    view.dispatch({
      changes: [
        ...(insertBefore ? [{ from: line.from, insert: insertBefore }] : []),
        ...(insertAfter ? [{ from: line.to, insert: insertAfter }] : []),
      ],
      selection: { anchor: head + insertBefore.length },
      userEvent: "input.tableSplit",
    });
    return; // 한 번에 한 분리(변경 범위가 넓어도 다음 입력에서 이어서)
  }
}

/** 밑줄형 제목('text\n---' H2 · 'text\n===' H1) — 타이핑하는 순간만
 *  Word식으로 되돌린다(splitTableAtPlainLine과 같은 패턴. 파싱은 다른 앱
 *  호환·기존 문서를 위해 그대로). 이 앱의 방침(2026-10-21): 제목은
 *  #/## 로만 — - 나 = 입력이 앞 줄을 H2/H1로 만들지 않게, 문서도 정규화해
 *  내보내기(comrak 표준 해석)까지 일관되게. 두 방향을 다룬다:
 *  (A) 밑줄 줄 자체에 타이핑 — 짝이 성립하는 순간 위에 빈 줄을 올린다.
 *      대시 3개+는 수평선이 되고(--- 입력 시 구분선이 안 생기던 주 원인),
 *      = 어떤 개수·대시 1-2개(목록 시작)는 그냥 분리만(렌더 억제와 짝).
 *  (B) 밑줄 바로 위 문단에 텍스트 입력 — 이미 짝이 성립한 문서에서
 *      편집할 때 제목으로 보이는 문제(기존 문서 치유). 사이에 빈 줄.
 *  트리에서 실제 SetextHeading1/2일 때만 동작(코드 블록 내부 --- 등 오탐
 *  없음). 트리가 늦으면 그 입력은 건너뛰고 다음 입력에서 다시 기회.
 *  되돌리기도 자유: 빈 줄을 지우면 다시 셋텍스트. */
function splitSetextUnderline(view: EditorView, u: import("@codemirror/view").ViewUpdate): void {
  const doc = u.state.doc;
  // 변경 줄 전부를 본다(멀티커서 — splitTableAtPlainLine과 같은 순회).
  // 한 번의 갱신에는 첫 분리 하나만(다음 입력에서 이어서).
  const seen = new Set<number>();
  u.changes.iterChangedRanges((fromA, toA) => {
    const first = doc.lineAt(fromA).number;
    const last = doc.lineAt(Math.min(toA, doc.length)).number;
    for (let n = first; n <= last; n++) seen.add(n);
  });
  // 인용구 밑줄("> ---")도 판정에 넣는다 — 마커를 걷어내고 본다
  // (2026-10-24 검토: 인용구 안에서만 제목이 되는 구멍). 분리 삽입은
  // 줄 시작에 하므로 인용구는 밑줄 앞에서 끝나고 구분선이 된다.
  const stripQuote = (t: string) => t.replace(/^(?:\s*>)+\s*/, "");
  // = 는 3개부터(2026-10-24 완화 — 수학식 등 '= ' 한 글자 흐름에 빈 줄이
  // 끼어들던 과시정). 1-2개 짝은 렌더 억제와 내보내기 정규화가 흡수한다.
  const ruleLine = /^\s{0,3}(?:-{3,}|={3,})\s*$/;
  const hasSetext = (from: number, to: number): boolean => {
    let hit = false;
    syntaxTree(u.state).iterate({
      from,
      to,
      enter: (node) => {
        if (/^SetextHeading[12]$/.test(node.name)) hit = true;
      },
    });
    return hit;
  };
  for (const target of seen) {
    if (target < 1 || target > doc.lines) continue;
    const line = doc.line(target);
    // (A) 변경 줄이 밑줄 줄 — 그 줄이 셋텍스트 밑줄인가.
    if (ruleLine.test(stripQuote(line.text))) {
      if (!hasSetext(line.from, line.to)) continue;
      view.dispatch({
        changes: { from: line.from, insert: "\n" },
        selection: { anchor: view.state.selection.main.head + 1 },
        userEvent: "input.setextSplit",
      });
      return;
    }
    // (B) 변경 줄 바로 아래가 밑줄 — 셋텍스트 짝의 내용 줄을 편집 중.
    if (target >= doc.lines) continue;
    const next = doc.line(target + 1);
    if (!ruleLine.test(stripQuote(next.text))) continue;
    if (!hasSetext(line.from, next.to)) continue;
    view.dispatch({
      changes: { from: line.to, insert: "\n" },
      // 명시 커서 — 없으면 삽입 지점(줄 끝)에 있던 커서가 \n 뒤(밑줄 줄)로
      // 밀려 다음 글자가 밑줄 줄에 들어간다.
      selection: { anchor: view.state.selection.main.head },
      userEvent: "input.setextSplit",
    });
    return;
  }
}

export type ViewMode = "edit" | "read" | "source";

export const editableComp = new Compartment();
export const behaviorComp = new Compartment();
export const previewEnabledComp = new Compartment();

/** 문서 변경(더티)·커서 이동 알림 — App이 콜백을 건다. ViewUpdate를 통째로
 *  넘겨 증분 통계(변경 범위만 훑기)를 가능하게 한다. */
export type ViewListener = (update: ViewUpdate) => void;
let listener: ViewListener | null = null;
export function setViewListener(fn: ViewListener | null) {
  listener = fn;
}

/** 태그 클릭 처리기(App이 설치 — 태그 검색 열기). */
let tagClickHandler: ((tag: string) => void) | null = null;
export function setTagClickHandler(fn: ((tag: string) => void) | null): void {
  tagClickHandler = fn;
}

/** 링크 클릭 처리기(App이 설치 — 내부 열기/외부 브라우저 분기). */
let linkClickHandler: ((url: string, baseDir: string) => void) | null = null;
export function setLinkClickHandler(fn: ((url: string, baseDir: string) => void) | null) {
  linkClickHandler = fn;
}

let imageImportHandler: ((view: EditorView, files: string[] | Blob | null) => void) | null = null;
export function setImageImportHandler(fn: typeof imageImportHandler): void {
  imageImportHandler = fn;
}

/** 등록된 앱 링크 열기 규칙으로 위임 — 우클릭 메뉴 등 프리뷰 클릭 밖 경로가
 *  같은 해석(마크다운 내부 열기·앵커 스크롤·외부 브라우저)을 공유하게 한다.
 *  등록 안 됨(웹 프리뷰 등)이면 false — 호출자가 폴백을 고른다. */
export function openLinkViaHandler(url: string, baseDir: string): boolean {
  if (!linkClickHandler) return false;
  linkClickHandler(url, baseDir);
  return true;
}

export interface PreviewConfigParam {
  baseDir: string;
  remoteImages: boolean;
  showImages: boolean;
  theme: "light" | "dark";
  imageWidths: Record<string, number>;
  bookmarks: number[];
  /** 메모가 달린 줄 번호(선택). */
  commentLines?: number[];
  /** 메모 전체 목록(배지 개수, 선택). */
  comments?: Array<{ lineNo: number; resolved: boolean }>;
  /** 긴 문장 점선 밑줄 토글·임계값. */
  longSentenceMarks?: boolean;
  longSentenceMin?: number;
  /** 서식 기호 보기(Word ¶). */
  formattingMarks?: boolean;
  tableWidths: Record<string, number[]>;
  wikiIndex: Map<string, string[]>;
}

/** 서식 복사용 markdown-it(지연 로드, 선택 시 예열). */
let mdItInstance: import("markdown-it").MarkdownIt | null = null;
let mdItLoading = false;

function prewarmCopyRenderer(): Promise<void> {
  if (mdItInstance) return Promise.resolve();
  if (mdItLoading) return mdItPromise ?? Promise.resolve();
  mdItLoading = true;
  mdItPromise = import("markdown-it").then((MarkdownIt) => {
    mdItInstance = new MarkdownIt.default({ html: false, linkify: true, breaks: false });
    mdItLoading = false;
  });
  void mdItPromise.catch(() => {
    mdItLoading = false; // 다음 선택에서 재시도
  });
  return mdItPromise;
}

let mdItPromise: Promise<void> | null = null;

/** 이 크기까지의 HTML 붙여넣기는 동기 변환(즉시 서식 반영). 넘으면
 *  plain 선행 삽입 + 비동기 변환 업그레이드로 프레임을 지킨다. */
const HTML_PASTE_SYNC_MAX = 512_000;
const HTML_PASTE_MAX = 4 * 1024 * 1024;

/** 수직 이동 가드 — CM의 시각 기준 이동이 블록 위젯(표·수식 등)을 넘어
 *  점프하며 사이 일반 줄을 건너뛰는 것을 교정한다. 이동 결과가 2줄 이상
 *  도약하고 그 사이에 커서를 얹을 수 있는 줄이 있으면 가장 가까운 줄로
 *  끊는다(열은 보존). 정차 가능 줄 판정: 위젯에 덮이지 않았거나, 편집
 *  모드에선 커서가 오면 원문으로 물러나는 위젯(수평선·수식·머메이드·FM)
 *  이라서 얹는 순간 텍스트가 되는 줄까지 포함한다 — 읽기 모드에선
 *  위젯이 안 물러나므로 예전처럼 전부 건너뛴다. */
export function guardedLineMove(view: EditorView, dir: 1 | -1): boolean {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.head);
  const moved = dir === 1 ? cursorLineDown(view) : cursorLineUp(view);
  if (!moved) return false;
  const head = view.state.selection.main.head;
  const endLine = view.state.doc.lineAt(head);
  const crossed = dir === 1 ? endLine.number - startLine.number : startLine.number - endLine.number;
  // 멀티커서(⌥⌘↑↓ 등)에선 단일 선택 디스패치가 커서들을 붕괴시킨다 — 놔둔다.
  if (sel.empty && crossed > 1 && view.state.selection.ranges.length === 1) {
    const stop = nearestStoppableLine(view, startLine, endLine, dir, sel.head - startLine.from);
    if (stop != null) view.dispatch({ selection: { anchor: stop } });
  }
  return true;
}

/** ⇧↑↓ 선택 확장도 같은 가드 — CM의 extendSel이 같은 moveVertically로
 *  위젯을 넘어 도약하면 머리만 가장 가까운 정차 줄로 끊는다(앵커 고정). */
export function guardedLineExtend(view: EditorView, dir: 1 | -1): boolean {
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.head);
  const moved = dir === 1 ? selectLineDown(view) : selectLineUp(view);
  if (!moved) return false;
  const head = view.state.selection.main.head;
  const endLine = view.state.doc.lineAt(head);
  const crossed = dir === 1 ? endLine.number - startLine.number : startLine.number - endLine.number;
  if (crossed > 1 && view.state.selection.ranges.length === 1) {
    const stop = nearestStoppableLine(view, startLine, endLine, dir, sel.head - startLine.from);
    if (stop != null) view.dispatch({ selection: { anchor: sel.anchor, head: stop } });
  }
  return true;
}

/** 도약 구간에서 방향 쪽 가장 가까운 '커서를 얹을 수 있는 줄'의 위치.
 *  없으면 null(원래 이동 결과를 유지). */
function nearestStoppableLine(
  view: EditorView,
  startLine: { number: number; from: number; to: number; length: number },
  endLine: { number: number; from: number; to: number; length: number },
  dir: 1 | -1,
  col: number,
): number | null {
  const covered = blockWidgetRangesBetween(
    view.state,
    Math.min(startLine.from, endLine.from),
    Math.max(startLine.to, endLine.to),
    view.state.facet(previewBehavior) === "reveal"
      ? (w) => !isRevealableBlockWidget(w)
      : undefined,
  );
  const isCovered = (pos: number): boolean => covered.some((r) => r.from <= pos && pos < r.to);
  const clamped = Math.min(col, Math.max(endLine.length, startLine.length));
  // 이동 방향 쪽(시작 줄 바로 옆)부터 탐색 — 가장 가까운 살아 있는 줄로.
  const first = dir === 1 ? startLine.number + 1 : startLine.number - 1;
  const last = dir === 1 ? endLine.number : endLine.number;
  for (let n = first; dir === 1 ? n <= last : n >= last; n += dir) {
    const line = view.state.doc.line(n);
    if (!isCovered(line.from)) return line.from + Math.min(clamped, line.length);
  }
  return null;
}

function baseExtensions(): Extension[] {
  return [
    historyField,
    history(),
    indentUnit.of("  "),
    // 본문 텍스트상자 이름 — CM 기본값엔 aria-label이 없어 스크린 리더가
    // 그냥 "textbox"로만 발음한다(접근성 트리 실측). 언어는 문구 주입 시점.
    EditorView.contentAttributes.of({ "aria-label": phrases.editorLabel }),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      // 검색 패널은 앱이 띄운다 — searchKeymap의 openSearchPanel은 CM 기본 UI라 Mod-f/Mod-g는 뺀다.
      ...searchKeymap.filter((b) => b.key !== "Mod-f" && b.key !== "Mod-g"),
      { key: "Mod-b", run: (v) => fmt.toggleBold(v), preventDefault: true },
      { key: "Mod-i", run: (v) => fmt.toggleItalic(v), preventDefault: true },
      { key: "Mod-Shift-x", run: (v) => fmt.toggleStrikethrough(v), preventDefault: true },
      { key: "Mod-Shift-h", run: (v) => fmt.toggleHighlight(v), preventDefault: true },
      { key: "Mod-Shift-c", run: (v) => fmt.toggleInlineCode(v), preventDefault: true },
      // 목록 자동 계속 — 항목 끝에서 Enter면 다음 마커를 잇는다(빈 항목은 종료).
      { key: "Enter", run: (v) => fmt.continueListOnEnter(v) },
      // 줄 편집 — Alt+↑↓ 이동·⌘D 복제·⌘⇧K 삭제(Word/VS Code 표준).
      { key: "Alt-ArrowUp", run: (v) => fmt.moveLines(v, true) },
      { key: "Alt-ArrowDown", run: (v) => fmt.moveLines(v, false) },
      { key: "Mod-d", run: (v) => fmt.duplicateLine(v), preventDefault: true },
      { key: "Mod-Shift-k", run: (v) => fmt.deleteLines(v), preventDefault: true },
      // 페이지 나눔 — Word Mac의 ⇧⌘Enter와 동일.
      { key: "Shift-Mod-Enter", run: (v) => fmt.insertPageBreak(v), preventDefault: true },
      // 멀티커서 — ⌥⌘↑/↓ 위·아래 커서 추가, ⌥⌘D 다음 같은 단어 선택(VS Code
      // 표준. ⌘D는 복제와 겹쳐 ⌥를 얹었다). ⌥클릭 커서 추가는 아래 facet,
      // Esc 단일 복귀는 기본 키맵(simplifySelection).
      { key: "Mod-Alt-ArrowUp", run: addCursorAbove, preventDefault: true },
      { key: "Mod-Alt-ArrowDown", run: addCursorBelow, preventDefault: true },
      { key: "Mod-Alt-d", run: selectNextOccurrence, preventDefault: true },
      // 서식 복사/붙여넣기(Format Painter) — ⌘⇧C는 인라인 코드라 ⌥⌘C/⌥⌘V.
      { key: "Mod-Alt-c", run: (v) => copyFormat(v), preventDefault: true },
      { key: "Mod-Alt-v", run: (v) => pasteFormat(v), preventDefault: true },
      { key: "Mod-Alt-Shift-v", run: (v) => pasteAsPlainText(v), preventDefault: true },
      // 입력 보조 — 괄호 쌍·마커 감싸기(선택 있을 때). 개별 문자 키.
      { key: "(", run: (v) => fmt.typePair(v, "(") },
      { key: "[", run: (v) => fmt.typePair(v, "[") },
      { key: '"', run: (v) => fmt.typePair(v, '"') },
      { key: "'", run: (v) => fmt.typePair(v, "'") },
      { key: "*", run: (v) => fmt.typePair(v, "*") },
      { key: "~", run: (v) => fmt.typePair(v, "~") },
      { key: "$", run: (v) => fmt.typePair(v, "$") },
      { key: "`", run: (v) => fmt.typePair(v, "`") },
      // 목록 들여쓰기 — Tab/Shift-Tab으로 단계 조정(Word 표준). 목록 밖에서는
      // 기본 Tab(포커스 이동)을 그대로 둔다.
      { key: "Shift-F3", run: (v) => fmt.cycleCase(v), preventDefault: true },
      { key: "Mod-j", run: (v) => fmt.joinCurrentLine(v) },
      { key: "Tab", run: (v) => fmt.tabTableCell(v, false) || fmt.indentListItem(v, false) || fmt.indentLines(v, false) },
      { key: "Shift-Tab", run: (v) => fmt.tabTableCell(v, true) || fmt.indentListItem(v, true) || fmt.indentLines(v, true) },
      // 강제 줄바꿈(Word Shift+Enter) — 마크다운 관례의 두 공백 + 개행.
      {
        key: "Shift-Enter",
        run: (v) => {
          v.dispatch({
            changes: { from: v.state.selection.main.head, insert: "  \n" },
            scrollIntoView: true,
            userEvent: "input.hardBreak",
          });
          return true;
        },
      },
      // Mod-e(모드 전환)·Mod-/(소스)는 메뉴 가속기와 앱 레벨 keydown이 처리한다.
    ]),
    markdown({
      base: markdownLanguage,
      extensions: [GFM, mathSyntax, frontMatterSyntax, wikiLinkSyntax],
      codeLanguages: languages,
      addKeymap: false,
    }),
    editorSyntaxHighlighting(),
    sourceModeClass,
    wikiAutocompletion(),
    headingFoldService,
    foldGutter(),
    // ⇧⌘[·] 는 탭 전환 — 폴드 키맵에서 뺀다(거터 클릭으로 접기).
    keymap.of(foldKeymap.filter((b) => b.key !== "Mod-Shift-[" && b.key !== "Mod-Shift-]")),
    livePreviewExtension(),
    indentGuidePlugin,
    searchHighlight(),
    trackChanges(),
    editorTheme,
    EditorView.lineWrapping,
    // 순수 ↑↓ — 위젯 점프 교정 가드. defaultKeymap의 화살표보다 먼저
    // 타야 한다(Prec.highest — 같은 배열 뒤에 넣는 것만으로는 이기지 못함).
    // ⇧↑↓(선택 확장)도 같은 moveVertically 점프를 쓰므로 함께 가드한다.
    Prec.highest(
      keymap.of([
        { key: "ArrowUp", run: (v) => guardedLineMove(v, -1) },
        { key: "ArrowDown", run: (v) => guardedLineMove(v, 1) },
        { key: "Shift-ArrowUp", run: (v) => guardedLineExtend(v, -1) },
        { key: "Shift-ArrowDown", run: (v) => guardedLineExtend(v, 1) },
      ]),
    ),
    // 멀티커서 — 이 facet이 없으면 상태가 강제로 단일 선택으로 붕괴된다
    // (⌥클릭·⌥⌘D·⌥⌘↑↓ 모두 무효). ⌥클릭 커서 추가(VS Code 표준),
    // ⌘클릭은 링크 열기 그대로.
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
    // ⌥드래그 사각(열) 선택 — 코어 @codemirror/view 내장(크로스헤어 커서 표시).
    rectangularSelection(),
    crosshairCursor(),
    widgetClickCollapse,
    previewConfigField,
    asyncEditPlugin,
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet) listener?.(u);
      // 표 행 사이에 일반 문장 타이핑 — 자동 빈 줄 분리(GFM이 파이프 없는
      // 줄까지 표 행으로 삼키는 것을 방지, 표가 갈라지며 문장은 문단이 된다).
      // 문단 바로 아래 --- 타이핑도 같은 치로 — 셋텍스트 H2가 되는 순간 빈
      // 줄을 올려 수평선이 되게 한다.
      if (u.docChanged && u.transactions.some((tr) => tr.isUserEvent("input.type"))) {
        splitTableAtPlainLine(u.view, u);
        splitSetextUnderline(u.view, u);
      }
      // 클릭 교정 최종 적용 — CM의 포인터 선택(userEvent select.pointer)이
      // 확정된 이 시점에 비로소 비교한다(그 전엔 덮일 수 있다).
      if (pendingClickFix !== null && u.selectionSet) {
        const fix = pendingClickFix;
        pendingClickFix = null;
        const keyboard = u.transactions.some((tr) => tr.isUserEvent("select.keyboard"));
        const sel = u.state.selection;
        const head = sel.main.head;
        // 키보드 이동이면 폐기(클릭이 아니게 됨). 그 외(포인터 확정 등)는
        // 여전히 어긋나 있을 때만 최종 교정.
        if (!keyboard && sel.ranges.length === 1 && !(head >= fix.from && head <= fix.to)) {
          const v = u.view;
          queueMicrotask(() => {
            if (v.dom.isConnected) v.dispatch({ selection: { anchor: fix.anchor } });
          });
        }
      }
    }),
    // 스마트 붙여넣기 — ① URL을 선택 텍스트 위에 붙이면 링크로(Word/워프류),
    // ② HTML 클립보드(Word·브라우저 복사)는 마크다운으로 변환해 삽입.
    EditorView.domEventHandlers({
      // 위키링크 호버 미리보기(Obsidian page preview v1) — 350ms 머무르면
      // 대상 문서 제목·첫 문단 팝오버(마커 정리 텍스트). 문서 읽기는 비동기.
      mouseover(event, view) {
        const el = (event.target as HTMLElement | null)?.closest?.(".md-wikilink, .md-link");
        clearWikiHoverTimer();
        // 메모 줄 호버 — 그 줄의 메모들을 팝오버(각주·위키와 같은 350ms).
        const hovPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (hovPos != null) {
          const line = view.state.doc.lineAt(hovPos);
          const comments = commentsProvider?.().filter((c) => c.lineNo === line.number) ?? [];
          if (comments.length > 0) {
            const { x: cx, y: cy } = event;
            wikiHoverTimer = window.setTimeout(() => {
              const body = comments.map((c) => (c.resolved ? `✓ ${c.text}` : c.text)).join("\n");
              showLinkPreview(cx, cy, `메모 · ${line.number}줄`, body);
            }, 350);
            return;
          }
        }
        // 각주 참조 호버 — 같은 문서의 정의를 팝오버(정의 찾기: 순수 스캔).
        const fn = (event.target as HTMLElement | null)?.closest?.(".md-footnote-ref");
        if (fn?.isConnected) {
          const label = fn.getAttribute("title")?.replace(/^\[\^|\]$/g, "") ?? "";
          const def = footnoteDefinition(view.state.doc.toString(), label);
          if (def) {
            const { x, y } = event;
            wikiHoverTimer = window.setTimeout(() => {
              showLinkPreview(x, y, `각주: ${label}`, def);
            }, 350);
          }
          return;
        }
        // 내부 마크다운 링크(data-md-link)도 같은 미리보기.
        const hoverPath =
          el?.getAttribute("data-wiki-path") ?? el?.getAttribute("data-md-link") ?? null;
        if (el?.isConnected && hoverPath && isInApp()) {
          const path = hoverPath;
          const x = event.clientX;
          const y = event.clientY;
          // 350ms 머무름 — 그 전에 떠나면 취소(지나가던 길에 팝오버가 튀는
          // 것 방지). 캐시 히트는 읽기 없이 즉시.
          wikiHoverTimer = window.setTimeout(() => {
            wikiHoverTimer = null;
            if (!el.isConnected) return;
            const cached = cachedLinkPreview(path);
            if (cached) {
              showLinkPreview(x, y, cached.title, cached.body, cached.html);
              return;
            }
            void (async () => {
              try {
                const doc = await api.readDocument(path);
                const p = previewTextOf(doc.text);
                // v2: 렌더 우선(마크다운-it 지연 공유 청크) — 실패 시 텍스트 폴백.
                const html = await previewHtmlOf(doc.text);
                rememberLinkPreview(path, { ...p, html });
                showLinkPreview(x, y, p.title, p.body, html);
              } catch {
                /* 열 수 없는 문서 — 조용히 */
              }
            })();
          }, 350);
        }
      },
      mouseout(event) {
        const t = event.target as HTMLElement | null;
        const el =
          t?.closest?.(".md-wikilink") ?? t?.closest?.(".md-link") ?? t?.closest?.(".md-footnote-ref");
        if (el) {
          clearWikiHoverTimer();
          scheduleHideLinkPreview();
        }
      },
      copy(event, view) {
        // 서식 복사 — 선택한 마크다운을 plain과 HTML로 **같이** 클립보드에 넣는다
        // (Word·메일에 굵게·제목·표가 유지되어 붙는다). setData는 이벤트 동기창에서만
        // 유효하므로 변환기는 선택 순간 프리워밍해 둔다(plain은 항상 원문 그대로 §4-2).
        const sel = view.state.selection.main;
        if (sel.empty || !event.clipboardData) return false;
        const md = view.state.sliceDoc(sel.from, sel.to);
        if (!/[#>*`\[|_]|^\d+\.\s/m.test(md)) return false; // 마크다운 문법이 있을 때만
        if (mdItInstance) {
          event.preventDefault();
          event.clipboardData.setData("text/plain", md);
          event.clipboardData.setData("text/html", `<meta charset="utf-8">${mdItInstance.render(md)}`);
          return true;
        }
        prewarmCopyRenderer(); // 다음 복사부터 서식 적용
        return false; // 이번에는 기본(plain) 복사
      },
      mouseup(event, view) {
        // 클릭 교정 — CM의 클릭→위치 매핑이 블록 위젯(표·수식) 인접 줄에서
        // 어긋나는 것을 잡는다(키보드 가드와 한 쌍). 교정은 CM의 포인터 선택이
        // 확정된 뒤(updateListener의 select.pointer) 최종 적용 — rAF 경합으로
        // 늦은 CM 갱신에 덮이지 않게. 4px 이상 이동(드래그)은 존중.
        const lineEl = clickedLineEl;
        const at = clickedAt;
        clickedLineEl = null;
        clickedAt = null;
        if (event.button !== 0 || !at) return false;
        if (Math.abs(event.clientX - at.x) + Math.abs(event.clientY - at.y) > 4) return false;
        if (!(lineEl instanceof HTMLElement) || !lineEl.isConnected) return false;
        const from = view.posAtDOM(lineEl, 0);
        const line = view.state.doc.lineAt(from);
        const guess = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
        pendingClickFix = {
          from: line.from,
          to: line.to,
          // 클릭 열 보존 — CM 추측 위치를 클릭한 줄 범위로 클램프.
          anchor: guess == null ? line.from : Math.min(Math.max(guess, line.from), line.to),
        };
        // CM의 클릭 선택 갱신이 이미 끝났을 수도(순서는 보장 없음) — 최종 폴백.
        setTimeout(() => {
          const fix = pendingClickFix;
          if (!fix || !view.dom.isConnected) return;
          pendingClickFix = null;
          const sel = view.state.selection;
          const head = sel.main.head;
          if (sel.ranges.length === 1 && !(head >= fix.from && head <= fix.to)) {
            view.dispatch({ selection: { anchor: fix.anchor } });
          }
        }, 80);
        return false;
      },
      paste(event, view) {
        if (view.state.readOnly) return false;
        // 이미지 붙여넣기(스크린샷) — 클립보드에 파일 아닌 이미지가 있으면
        // 문서 폴더 assets/ 에 저장하고 표준 ![...](assets/...) 참조를 삽입한다.
        // 원문은 표준 마크다운 이미지 구문만 — 무손실(§4-2).
        const items = event.clipboardData?.items;
        const imgItem = items
          ? Array.from(items).find((it) => it.kind === "file" && it.type.startsWith("image/"))
          : undefined;
        if (imgItem && isInApp() && imageImportHandler) {
          event.preventDefault();
          // The event owns this snapshot; never reread the mutable system clipboard.
          imageImportHandler(view, imgItem.getAsFile());
          return true;
        }
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const sel = view.state.selection.main;
        // 이미지 파일 경로 붙여넣기 — 절대 경로 + 이미지 확장자면 assets/로
        // 임포트해 참조 삽입(드래그앤드롭과 같은 경로, Word 붙여넣기 관례).
        if (
          isInApp() && imageImportHandler &&
          /^\/[^\r\n\0]+\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i.test(text.trim())
        ) {
          event.preventDefault();
          imageImportHandler(view, [text.trim()]);
          return true;
        }
        const isUrl = /^https?:\/\/\S+$/i.test(text.trim()) && !/\s/.test(text.trim());
        if (!sel.empty && isUrl) {
          event.preventDefault();
          const selected = view.state.sliceDoc(sel.from, sel.to);
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: `[${selected}](${text.trim()})` },
            userEvent: "input.pasteLink",
          });
          return true;
        }
        // TSV(엑셀·시트) → 마크다운 표(Word가 엑셀 표를 표로 붙이듯).
        // 서식 없는 HTML이 있는 경우(시트 복사) text/html 경로가 이긴다.
        if (looksLikeTsv(text)) {
          event.preventDefault();
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: `${tsvToTable(text)}\n` },
            userEvent: "input.pasteTable",
          });
          return true;
        }
        const html = event.clipboardData?.getData("text/html") ?? "";
        if (html.trim()) {
          if (html.length > HTML_PASTE_MAX) {
            event.preventDefault();
            if (text) view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: text }, userEvent: "input.pastePlain",
            });
            clipboardNotice(phrases.clipboardHtmlTooLarge, "info");
            return true;
          }
          // 거대 HTML 붙여넣기는 변환에 프레임을 통째로 먹는다 — plain을 먼저
          // 붙이고(즉시), 변환은 다음 태스크에서 끝나면 그 범위를 마크다운으로
          // 바꿔치기한다. 그 사이 사용자가 건드렸으면(범위 검증 실패) 그대로 둔다.
          if (html.length > HTML_PASTE_SYNC_MAX) {
            event.preventDefault();
            if (text) view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: text },
              userEvent: "input.pastePlain",
            });
            const target = captureAsyncEdit(view, "html-upgrade", {
              from: sel.from, to: text ? sel.from + text.length : sel.to,
            });
            setTimeout(() => {
              if (!target) return;
              try {
                if (!target.current()) return;
                const md = htmlToMarkdown(html);
                if (md && md !== text) target.replace(md, "input.pasteHtmlUpgrade");
              } catch {
                clipboardNotice(phrases.clipboardHtmlFailed);
              } finally { target.finish(); }
            }, 16);
            return true;
          }
          let md: string | null;
          try { md = htmlToMarkdown(html); }
          catch {
            clipboardNotice(phrases.clipboardHtmlFailed);
            if (!text) { event.preventDefault(); return true; }
            return false;
          }
          if (md && md !== text) {
            event.preventDefault();
            view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: md },
              userEvent: "input.pasteHtml",
            });
            return true;
          }
          if (!text) { event.preventDefault(); return true; }
        }
        return false;
      },
      mousedown(event, view) {
        // ⌥클릭은 커서 추가 전용 — 링크·태그·각주 클릭 처리에서 제외.
        if (event.altKey) return false;
        const target = event.target as HTMLElement | null;
        // 클릭 교정용 — 실제 클릭한 텍스트 줄과 지점(DOM 기준, 레이아웃 불필요).
        clickedLineEl = target?.closest?.(".cm-line") ?? null;
        clickedAt = { x: event.clientX, y: event.clientY };
        // 해시태그 클릭 → 워크스페이스 태그 검색으로.
        const tagEl = target?.closest?.(".md-tag");
        if (tagEl) {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos != null) {
            const line = view.state.doc.lineAt(pos);
            const m = /#[\p{L}\p{N}_\-\/]+/u.exec(line.text.slice(Math.max(0, pos - line.from - 1)));
            const tagText = (m?.[0] ?? tagEl.textContent ?? "").replace(/^#/, "");
            event.preventDefault();
            tagClickHandler?.(tagText);
            return true;
          }
        }
        // 각주 참조 → 정의 줄로 이동(Word 각주 이동).
        const fnEl = target?.closest?.(".md-footnote-ref");
        if (fnEl) {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos != null && gotoFootnoteDefinition(view, pos)) {
            event.preventDefault();
            return true;
          }
        }
        // 위키링크 위젯 — 파일명의 #/%를 URL 구분자로 오인하지 않도록 인코딩.
        const wikiEl = target?.closest?.(".md-wikilink");
        if (wikiEl) {
          event.preventDefault();
          const path = wikiEl.getAttribute("data-wiki-path");
          if (path) {
            const anchorFrag = wikiEl.getAttribute("data-wiki-anchor");
            const href = path.split("/").map(encodeURIComponent).join("/");
            linkClickHandler?.(anchorFrag ? `${href}#${encodeURIComponent(anchorFrag)}` : href, "");
          }
          return true;
        }
        const linkEl = target?.closest?.(".md-link, .md-url");
        if (!linkEl) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        const link = findLinkAt(view.state, pos);
        if (link) {
          event.preventDefault();
          const base = view.state.field(previewConfigField, false)?.baseDir ?? "";
          linkClickHandler?.(link.url, base);
          return true;
        }
        return false;
      },
    }),
  ];
}

function modeValues(mode: ViewMode): Extension[] {
  const editable =
    mode === "read"
      ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
      : [EditorState.readOnly.of(false), EditorView.editable.of(true)];
  const behavior = previewBehavior.of(mode === "read" ? "render" : mode === "source" ? "source" : "reveal");
  // 라이브 프리뷰 확장은 항상 등록 — 소스 모드는 previewBehavior "source"로
  // 장식 발행을 끈다(확장을 빼면 설정 필드·재진입 시드가 사라진다).
  const preview = livePreviewExtension();
  return [
    editableComp.of(editable),
    behaviorComp.of(behavior),
    previewEnabledComp.of(preview),
    // 자리만 잡는다 — 상태 생성 직후 applyConfig가 실제 설정으로 바꾼다.
    writingComp.of(writingExtension({ typewriter: false, focus: false, sentence: false, active: mode !== "read" })),
    smartPunctComp.of(smartPunctExtension(true)),
  ];
}

/** 새 문서 상태 만들기(탭 열기·세션 복원). 설정(경로·테마)은 setState 뒤
 *  applyPreviewConfig로 반영한다. */
export function createDocState(doc: string, mode: ViewMode): EditorState {
  return EditorState.create({
    doc,
    extensions: [baseExtensions(), modeValues(mode)],
  });
}

/** 상태에 프리뷰 설정 반영(문서 경로·이미지 정책·테마). */
export function applyPreviewConfig(view: EditorView, config: PreviewConfigParam): void {
  view.dispatch({ effects: setPreviewConfig.of(config) });
}

/** pos 근처 각주 참조의 라벨을 얻는다. */
function footnoteLabelAt(state: EditorState, pos: number): string | null {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  const re = /\[\^([^\]\s]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    const from = line.from + m.index;
    if (pos >= from && pos <= from + m[0].length) return m[1];
  }
  return null;
}

/** 각주 참조 클릭 → 정의 줄로 커서 이동. 정의가 없으면 첫 참조로. */
function gotoFootnoteDefinition(view: EditorView, pos: number): boolean {
  const label = footnoteLabelAt(view.state, pos);
  if (!label) return false;
  const doc = view.state.doc;
  const defRe = new RegExp(`^\\s*\\[\\^${label.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}\\]:`);
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (defRe.test(line.text)) {
      smoothScrollIntoView(view, line.from);
      view.dispatch({ selection: { anchor: line.from } });
      return true;
    }
  }
  return false;
}

/** 현재 프리뷰 설정 회독(재빌드 트리거용). */
function currentPreviewConfig(view: EditorView): PreviewConfigParam {
  return (
    (view.state.field(previewConfigField, false) as PreviewConfigParam | undefined) ?? {
      baseDir: "",
      remoteImages: true,
      showImages: true,
      theme: "light",
      imageWidths: {},
      bookmarks: [],
      tableWidths: {},
      wikiIndex: new Map(),
    }
  );
}

/** 소스 모드 표식 — previewBehavior가 "source"면 에디터 루트에 클래스를
 *  건다. 태그 하이라이트의 제목 스타일(theme.md-tag-h*)은 이 스코프에서만
 *  붙는다 — 편집·읽기 모드의 셋텍스트 억제를 우회하지 않게(소스 모드는
 *  '원문 그대로'라 CommonMark 해석을 보여주는 게 오히려 정직하다). */
const sourceModeClass = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      this.sync(view);
    }
    update(u: ViewUpdate) {
      if (u.startState.facet(previewBehavior) !== u.state.facet(previewBehavior)) this.sync(u.view);
    }
    sync(view: EditorView) {
      view.dom.classList.toggle("cm-source-mode", view.state.facet(previewBehavior) === "source");
    }
  },
);

/** 모드 전환 — 같은 버퍼 위에서 확장만 재구성(내용 불변, §4-2 5항 (c)). */
export function switchMode(view: EditorView, mode: ViewMode): void {
  const editable =
    mode === "read"
      ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
      : [EditorState.readOnly.of(false), EditorView.editable.of(true)];
  const writing = view.state.facet(writingConf);
  view.dispatch({
    effects: [
      editableComp.reconfigure(editable),
      behaviorComp.reconfigure(previewBehavior.of(mode === "read" ? "render" : mode === "source" ? "source" : "reveal")),
      previewEnabledComp.reconfigure(livePreviewExtension()),
      // 모드 전환 자체는 doc/선택/뷰포트를 바꾸지 않는다 — 설정 이펙트로 재빌드를
      // 트리거한다(예: 읽기→편집 전환 시 커서 줄 원문 노출이 즉시 반영되게).
      setPreviewConfig.of(currentPreviewConfig(view)),
      // 집필 기능의 활성 비트만 뒤집는다(타이프라이터·포커스 설정은 유지).
      writingComp.reconfigure(writingExtension({ ...writing, active: mode !== "read" })),
    ],
  });
  resetSearch(view);
}

/** 문서 전체를 새 상태로(외부 변경 다시 읽기) — 커서·스크롤은 호출자가 복원. */
export function replaceDoc(view: EditorView, text: string): void {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
}

/** 앵커·목차 이동용 부드러운 스크롤 — 이동하는 동안만 scroll-behavior를 켠다.
 *  (상시 켜면 편집 중 CM의 스크롤 보정까지 애니메이션돼 뛰는 느낌을 낸다.)
 *  읽기 모드는 스크롤 컨테이너가 editor-area라 그쪽도 같이 켠다. */
export function smoothScrollIntoView(view: EditorView, pos: number): void {
  const scroller = view.scrollDOM;
  const area = scroller.closest(".editor-area.read-mode");
  const targets: HTMLElement[] = area instanceof HTMLElement ? [scroller, area] : [scroller];
  for (const el of targets) el.style.scrollBehavior = "smooth";
  let done = false;
  const reset = () => {
    if (done) return;
    done = true;
    for (const el of targets) el.style.scrollBehavior = "";
  };
  scroller.addEventListener("scrollend", reset, { once: true });
  setTimeout(reset, 700);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
}

/** 테스트 전용 노출. */
export const __testingCopy = {
  prewarm: prewarmCopyRenderer,
  ready: () => mdItInstance !== null,
  render: (md: string) => mdItInstance?.render(md) ?? null,
};

/** 직전 mousedown이 누른 텍스트 줄·지점(클릭 교정용). */
let clickedLineEl: HTMLElement | null = null;
let clickedAt: { x: number; y: number } | null = null;
/** mouseup이 등록한 클릭 교정 — select.pointer 확정 후 적용. */
let pendingClickFix: { from: number; to: number; anchor: number } | null = null;

/** 블록 위젯(표·이미지·수평선 등) 클릭 = 선택 해제.
 *  위젯은 ignoreEvent=true라 CM이 그 안의 mousedown을 처리하지 않는다 —
 *  ⌘A 뒤 표 셀을 클릭하면 화면 선택은 풀린 듯해도 CM 선택은 문서 전체로
 *  남아, 모든 #·** 원문 마커가 노출된 채 굳었다(2026-10-16 사용자 보고).
 *  텍스트 줄 클릭과 같게, 범위 선택이 있으면 위젯 위치 커서로 접는다.
 *  (위젯 자체 핸들러 — 수식·펜스의 클릭=편집 — 는 이 뒤에 실행돼 덮어쓴다.) */
const widgetClickCollapse = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      view.contentDOM.addEventListener("mousedown", this.onDown, true);
    }
    onDown = (e: MouseEvent): void => {
      const view = this.view;
      if (e.button !== 0 || e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return;
      const sel = view.state.selection;
      if (sel.ranges.length === 1 && sel.main.empty) return;
      // contentDOM 직속 자식까지 올라간다 — 텍스트 줄(.cm-line)이 아닌 블록 위젯만.
      let block = e.target instanceof Element ? e.target : null;
      while (block && block.parentElement !== view.contentDOM) block = block.parentElement;
      if (!(block instanceof HTMLElement) || block.contentEditable !== "false") return;
      if (block.classList.contains("cm-line") || block.classList.contains("cm-gap")) return;
      view.dispatch({ selection: { anchor: view.posAtDOM(block) }, userEvent: "select.pointer" });
    };
    destroy() {
      this.view.contentDOM.removeEventListener("mousedown", this.onDown, true);
    }
  },
);

/** 서식 없이 붙여넣기 — HTML→MD 변환 없이 텍스트 그대로. */
export function pasteAsPlainText(view: EditorView): boolean {
  return pasteTextFromClipboard(view);
}
