// CodeMirror 확장 조립. 한 창에 EditorView 하나 — 탭 전환은 setState로
// 버퍼만 갈아끼운다(비활성 탭은 EditorState만 메모리에 남는다, §7).
//
// 모드(읽기/편집/소스)는 Compartment로 재구성한다: 같은 버퍼를 보는 세 가지
// "보기"일 뿐이므로 전환에 변환이 없다(§0 D4/D5).

import { searchKeymap, selectNextOccurrence } from "@codemirror/search";
import { addCursorAbove, addCursorBelow } from "./multiCursor";
import { looksLikeTsv, tsvToTable } from "./tsvTable";
import { trackChanges } from "./trackChanges";
import { occurrenceHighlight } from "./occurrences";
import { copyFormat, pasteFormat } from "./formatPainter";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import { crosshairCursor, EditorView, keymap, rectangularSelection, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyField, historyKeymap } from "@codemirror/commands";
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
  findLinkAt,
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
import { api, isInApp } from "../api";
import { relPath } from "../paths";
import * as fmt from "./format";
import { resetSearch, searchHighlight } from "../search/searchCm";
import { writingComp, writingConf, writingExtension } from "./writing";
import { smartPunctComp, smartPunctExtension } from "./smartPunct";

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

function baseExtensions(): Extension[] {
  return [
    historyField,
    history(),
    indentUnit.of("  "),
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
    wikiAutocompletion(),
    headingFoldService,
    foldGutter(),
    // ⇧⌘[·] 는 탭 전환 — 폴드 키맵에서 뺀다(거터 클릭으로 접기).
    keymap.of(foldKeymap.filter((b) => b.key !== "Mod-Shift-[" && b.key !== "Mod-Shift-]")),
    livePreviewExtension(),
    searchHighlight(),
    occurrenceHighlight(),
    trackChanges(),
    editorTheme,
    EditorView.lineWrapping,
    // 멀티커서 — 이 facet이 없으면 상태가 강제로 단일 선택으로 붕괴된다
    // (⌥클릭·⌥⌘D·⌥⌘↑↓ 모두 무효). ⌥클릭 커서 추가(VS Code 표준),
    // ⌘클릭은 링크 열기 그대로.
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
    // ⌥드래그 사각(열) 선택 — 코어 @codemirror/view 내장(크로스헤어 커서 표시).
    rectangularSelection(),
    crosshairCursor(),
    previewConfigField,
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet) listener?.(u);
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
      paste(event, view) {
        // 이미지 붙여넣기(스크린샷) — 클립보드에 파일 아닌 이미지가 있으면
        // 문서 폴더 assets/ 에 저장하고 표준 ![...](assets/...) 참조를 삽입한다.
        // 원문은 표준 마크다운 이미지 구문만 — 무손실(§4-2).
        const items = event.clipboardData?.items;
        const imgItem = items
          ? Array.from(items).find((it) => it.kind === "file" && it.type.startsWith("image/"))
          : undefined;
        if (imgItem) {
          const tab = view.state.field(previewConfigField, false);
          const baseDir = tab?.baseDir ?? "";
          if (baseDir && isInApp()) {
            event.preventDefault();
            void (async () => {
              try {
                const abs = await api.saveClipboardImage(baseDir);
                // relPath는 이미 assets/를 포함한다 — 다시 붙이면 이중 경로가 된다.
                const rel = relPath(baseDir, abs);
                const sel = view.state.selection.main;
                view.dispatch({
                  changes: { from: sel.from, to: sel.to, insert: `![](${rel})\n` },
                  selection: { anchor: sel.from + 4 },
                  userEvent: "input.pasteImage",
                });
              } catch (e) {
                // 이미지 저장 실패 — 텍스트 붙여넣기로 폴백하지 않고 알린다.
                console.warn("이미지 붙여넣기 실패", e);
              }
            })();
            return true;
          }
        }
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const sel = view.state.selection.main;
        // 이미지 파일 경로 붙여넣기 — 절대 경로 + 이미지 확장자면 assets/로
        // 임포트해 참조 삽입(드래그앤드롭과 같은 경로, Word 붙여넣기 관례).
        if (
          isInApp() &&
          /^\/(\S+)\.(png|jpe?g|gif|webp|svg|bmp|heic|avif|tiff?)$/i.test(text.trim())
        ) {
          event.preventDefault();
          void (async () => {
            try {
              const tab = view.state.field(previewConfigField, false);
              const dir = tab?.baseDir ?? "";
              if (!dir) return;
              const abs = await api.importImage(text.trim(), dir);
              fmt.insertImageRef(view, relPath(dir, abs));
              view.focus();
            } catch {
              // 임포트 실패(존재 안 함 등) — 일반 텍스트로 폴백.
              view.dispatch({
                changes: { from: sel.from, to: sel.to, insert: text },
                userEvent: "input.pastePlain",
              });
            }
          })();
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
        if (!plainPasteQueued && looksLikeTsv(text)) {
          event.preventDefault();
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: `${tsvToTable(text)}\n` },
            userEvent: "input.pasteTable",
          });
          return true;
        }
        // 서식 없이 붙여넣기(대기 중이면) — HTML 변환·링크 스마트 모두 건너뛴다.
        if (plainPasteQueued) {
          plainPasteQueued = false;
          event.preventDefault();
          const sel = view.state.selection.main;
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: text },
            userEvent: "input.pastePlain",
          });
          return true;
        }
        const html = event.clipboardData?.getData("text/html") ?? "";
        if (html.trim()) {
          // 거대 HTML 붙여넣기는 변환에 프레임을 통째로 먹는다 — plain을 먼저
          // 붙이고(즉시), 변환은 다음 태스크에서 끝나면 그 범위를 마크다운으로
          // 바꿔치기한다. 그 사이 사용자가 건드렸으면(범위 검증 실패) 그대로 둔다.
          if (html.length > HTML_PASTE_SYNC_MAX) {
            event.preventDefault();
            view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: text },
              userEvent: "input.pastePlain",
            });
            const from = sel.from;
            const to = from + text.length;
            setTimeout(() => {
              if (!view.dom.isConnected) return;
              const md = htmlToMarkdown(html);
              if (!md || md === text) return;
              if (view.state.doc.sliceString(from, to) === text) {
                view.dispatch({
                  changes: { from, to, insert: md },
                  userEvent: "input.pasteHtmlUpgrade",
                });
              }
            }, 16);
            return true;
          }
          const md = htmlToMarkdown(html);
          if (md && md !== text) {
            event.preventDefault();
            view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: md },
              userEvent: "input.pasteHtml",
            });
            return true;
          }
        }
        return false;
      },
      mousedown(event, view) {
        // ⌥클릭은 커서 추가 전용 — 링크·태그·각주 클릭 처리에서 제외.
        if (event.altKey) return false;
        const target = event.target as HTMLElement | null;
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
        // 위키링크 위젯 — 해석된 절대 경로를 링크 처리기로(그대로 markdown 분류).
        const wikiEl = target?.closest?.(".md-wikilink");
        if (wikiEl) {
          event.preventDefault();
          const path = wikiEl.getAttribute("data-wiki-path");
          if (path) {
            const anchorFrag = wikiEl.getAttribute("data-wiki-anchor");
            linkClickHandler?.(anchorFrag ? `${path}#${anchorFrag}` : path, "");
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
  const behavior = previewBehavior.of(mode === "read" ? "render" : "reveal");
  const preview = mode === "source" ? [] : livePreviewExtension();
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
      behaviorComp.reconfigure(previewBehavior.of(mode === "read" ? "render" : "reveal")),
      previewEnabledComp.reconfigure(mode === "source" ? [] : livePreviewExtension()),
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

// — 서식 없이 붙여넣기(⌥⌘⇧V) — 클립보드 읽기 실패 시 다음 붙여넣기에 적용. —
let plainPasteQueued = false;

/** 서식 없이 붙여넣기 — HTML→MD 변환 없이 텍스트 그대로. */
export function pasteAsPlainText(view: EditorView): boolean {
  void (async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        userEvent: "input.pastePlain",
      });
    } catch {
      // 클립보드 읽기 거부 — 다음 붙여넣기 이벤트에서 평문으로.
      plainPasteQueued = true;
    }
  })();
  return true;
}
