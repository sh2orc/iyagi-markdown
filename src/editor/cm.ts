// CodeMirror 확장 조립. 한 창에 EditorView 하나 — 탭 전환은 setState로
// 버퍼만 갈아끼운다(비활성 탭은 EditorState만 메모리에 남는다, §7).
//
// 모드(읽기/편집/소스)는 Compartment로 재구성한다: 같은 버퍼를 보는 세 가지
// "보기"일 뿐이므로 전환에 변환이 없다(§0 D4/D5).

import { searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
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
import * as fmt from "./format";
import { resetSearch, searchHighlight } from "../search/searchCm";

export type ViewMode = "edit" | "read" | "source";

export const editableComp = new Compartment();
export const behaviorComp = new Compartment();
export const previewEnabledComp = new Compartment();

/** 문서 변경(더티)·커서 이동 알림 — App이 콜백을 건다. */
export type ViewListener = (view: EditorView) => void;
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
}

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
      { key: "Mod-Shift-k", run: (v) => fmt.toggleInlineCode(v), preventDefault: true },
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
      if (u.docChanged || u.selectionSet) listener?.(u.view);
    }),
    // 링크 클릭 — 텍스트 장식이라 DOM 이벤트로 역산한다.
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const target = event.target as HTMLElement | null;
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
