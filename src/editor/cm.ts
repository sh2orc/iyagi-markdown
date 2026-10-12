// CodeMirror 확장 조립. 한 창에 EditorView 하나 — 탭 전환은 setState로
// 버퍼만 갈아끼운다(비활성 탭은 EditorState만 메모리에 남는다, §7).
//
// 모드(읽기/편집/소스)는 Compartment로 재구성한다: 같은 버퍼를 보는 세 가지
// "보기"일 뿐이므로 전환에 변환이 없다(§0 D4/D5).

import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { defaultKeymap, history, historyField, historyKeymap } from "@codemirror/commands";
import { GFM } from "@lezer/markdown";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { indentUnit } from "@codemirror/language";

import {
  findLinkAt,
  livePreviewExtension,
  previewBehavior,
  previewConfigField,
  setPreviewConfig,
} from "./livePreview";
import { editorSyntaxHighlighting, editorTheme } from "./theme";
import { mathSyntax } from "./mathSyntax";
import { htmlToMarkdown } from "./htmlPaste";
import { isInApp } from "../api";
import { relPath } from "../paths";
import * as fmt from "./format";
import { resetSearch, searchHighlight } from "../search/searchCm";

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
  tableWidths: Record<string, number[]>;
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
      { key: "Mod-Shift-c", run: (v) => fmt.toggleInlineCode(v), preventDefault: true },
      // 목록 자동 계속 — 항목 끝에서 Enter면 다음 마커를 잇는다(빈 항목은 종료).
      { key: "Enter", run: (v) => fmt.continueListOnEnter(v) },
      // 줄 편집 — Alt+↑↓ 이동·⌘D 복제·⌘⇧K 삭제(Word/VS Code 표준).
      { key: "Alt-ArrowUp", run: (v) => fmt.moveLines(v, true) },
      { key: "Alt-ArrowDown", run: (v) => fmt.moveLines(v, false) },
      { key: "Mod-d", run: (v) => fmt.duplicateLine(v), preventDefault: true },
      { key: "Mod-Shift-k", run: (v) => fmt.deleteLines(v), preventDefault: true },
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
      { key: "Tab", run: (v) => fmt.indentListItem(v, false) },
      { key: "Shift-Tab", run: (v) => fmt.indentListItem(v, true) },
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
      extensions: [GFM, mathSyntax],
      codeLanguages: languages,
      addKeymap: false,
    }),
    editorSyntaxHighlighting(),
    livePreviewExtension(),
    searchHighlight(),
    editorTheme,
    EditorView.lineWrapping,
    previewConfigField,
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet) listener?.(u);
    }),
    // 스마트 붙여넣기 — ① URL을 선택 텍스트 위에 붙이면 링크로(Word/워프류),
    // ② HTML 클립보드(Word·브라우저 복사)는 마크다운으로 변환해 삽입.
    EditorView.domEventHandlers({
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
            void import("../api").then(async (a) => {
              try {
                const abs = await a.api.saveClipboardImage(baseDir);
                const rel = relPath(baseDir, abs);
                const sel = view.state.selection.main;
                view.dispatch({
                  changes: { from: sel.from, to: sel.to, insert: `![](assets/${rel})\n` },
                  selection: { anchor: sel.from + 4 },
                  userEvent: "input.pasteImage",
                });
              } catch (e) {
                // 이미지 저장 실패 — 텍스트 붙여넣기로 폴백하지 않고 알린다.
                console.warn("이미지 붙여넣기 실패", e);
              }
            });
            return true;
          }
        }
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const sel = view.state.selection.main;
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
        const target = event.target as HTMLElement | null;
        // 각주 참조 → 정의 줄로 이동(Word 각주 이동).
        const fnEl = target?.closest?.(".md-footnote-ref");
        if (fnEl) {
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos != null && gotoFootnoteDefinition(view, pos)) {
            event.preventDefault();
            return true;
          }
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
    }
  );
}

/** 모드 전환 — 같은 버퍼 위에서 확장만 재구성(내용 불변, §4-2 5항 (c)). */
export function switchMode(view: EditorView, mode: ViewMode): void {
  const editable =
    mode === "read"
      ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
      : [EditorState.readOnly.of(false), EditorView.editable.of(true)];
  view.dispatch({
    effects: [
      editableComp.reconfigure(editable),
      behaviorComp.reconfigure(previewBehavior.of(mode === "read" ? "render" : "reveal")),
      previewEnabledComp.reconfigure(mode === "source" ? [] : livePreviewExtension()),
      // 모드 전환 자체는 doc/선택/뷰포트를 바꾸지 않는다 — 설정 이펙트로 재빌드를
      // 트리거한다(예: 읽기→편집 전환 시 커서 줄 원문 노출이 즉시 반영되게).
      setPreviewConfig.of(currentPreviewConfig(view)),
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
