// 앱 셸 — 창 안의 모든 것을 연결한다: 탭·사이드바·에디터·패널·내보내기·이벤트.
// 에디터 DOM은 CodeMirror가 소유하고 React는 컨테이너만 렌더링한다.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { EditorView } from "@codemirror/view";

import {
  api,
  initBridge,
  isInApp,
  onFsEvent,
  onMenu,
  onOpenFiles,
  onSettingsChanged,
  onRecentChanged,
  onFavoritesChanged,
  onWorkspaceHistoryChanged,
  onCommentsChanged,
  onBaselineChanged,
  onBookmarksChanged,
  pickOpenFile,
  pickOpenFolder,
  pickSave,
  webviewWindowApi,
  type DocumentEdge,
} from "./api";
import { AppStore, resolveTheme, type ExportKind, type Tab } from "./app/store";
import { scaledLineWidth } from "./app/docStyle";
import { useOverlayFocus } from "./app/overlayFocus";
import { guardAppCommands, handleAppShortcut } from "./app/appCommands";
import { closingDocumentsUnchanged, restoreUnclosedDrafts } from "./app/closeDocuments";
import { setImageImportHandler, setLinkClickHandler, setViewListener, smoothScrollIntoView } from "./editor/cm";
import { phrases, setPhrases } from "./app/phrases";
import { setClipboardNoticeHandler } from "./editor/clipboard";
import { findNext, searchStateOf } from "./search/searchCm";
import { invalidateLinkPreviews } from "./editor/linkPreview";
import { frontMatterMeta, stripFrontMatter } from "./editor/frontmatter";
import { EPUB_CSS, epubChapterInputs, firstEpubLocalImage, splitEpubChapters } from "./export/epub";
import { applyEmbeds, captureExportSnapshot, type ExportSnapshot } from "./export/snapshot";
import { countHeadingLinks, headingAtCursor, retargetHeadingLinks, rewrittenHeadingLine } from "./editor/headingRename";
import { RenameHeadingDialog } from "./components/RenameHeadingDialog";
import type { TreeNode } from "./api";
import { snapshotHtmlOptions, type PdfOptions } from "./export/preview";
import type { ExportResult } from "./export/result";
import { resolveLink } from "./links";
import { makeT, type Lang } from "./i18n";
import { TabBar, documentTabId } from "./components/TabBar";
import { Sidebar } from "./components/Sidebar";
import { TocPanel } from "./components/TocPanel";
import { SearchPanel } from "./components/SearchPanel";
import { StatusBar } from "./components/StatusBar";
import { CloseConfirm, ConflictDialog } from "./components/Modals";
import { ExportSheet } from "./components/ExportSheet";
import { Toolbar } from "./components/Toolbar";
import { MiniToolbar } from "./components/MiniToolbar";
import { ContextMenu } from "./components/ContextMenu";
import { setImageResizeHandler, setImageViewerHandler, setTableHeaderClickHandler, setFrontMatterEditHandler, setImageCaptionHandler, setEmbedContentHandler, setEmbedOpenHandler } from "./editor/widgets";
import { setTableWidthsSaveHandler } from "./editor/livePreview";
import { setTagClickHandler } from "./editor/cm";
import { setWikiDocsProvider, setTagListProvider } from "./editor/wikiComplete";
import { workspaceCompletions } from "./app/workspaceCompletions";
import { SettingsSheet } from "./components/SettingsSheet";
import { StylePanel } from "./components/StylePanel";
import { PrintPreview } from "./components/PrintPreview";
import { SourcePreview } from "./components/SourcePreview";
import { ShortcutsPanel } from "./components/ShortcutsPanel";
import { StatsPanel } from "./components/StatsPanel";
import { SymbolPanel } from "./components/SymbolPanel";
import { TableDialog } from "./components/TableDialog";
import { CommentsPanel } from "./components/CommentsPanel";
import { CommentDialog } from "./components/CommentDialog";
import { FrontMatterDialog } from "./components/FrontMatterDialog";
import { RefPane } from "./components/RefPane";
import { TrackPanel } from "./components/TrackPanel";
import { findImageAt, previewConfigField } from "./editor/livePreview";
import { documentImages, type DocumentImage } from "./editor/documentImages";
import { LinkDialog } from "./components/LinkDialog";
import { captureInlineLinkEdit, type InlineLinkEdit } from "./editor/inlineLinkEdit";
import { ReviewPanel } from "./components/ReviewPanel";
import { Welcome } from "./components/Welcome";
import { CommandPalette } from "./components/CommandPalette";
import { TemplatePicker } from "./components/TemplatePicker";
import { VersionsPanel } from "./components/VersionsPanel";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { BrokenLinksPanel } from "./components/BrokenLinksPanel";
import { WorkspaceSearch } from "./components/WorkspaceSearch";
import { ImageViewer } from "./components/ImageViewer";
import { DiffPanel } from "./components/DiffPanel";
import { GraphView } from "./components/GraphView";
import * as fmt from "./editor/format";

const ioAdapter = {
  getWorkspaceHistory: () => api.getWorkspaceHistory(),
  updateWorkspaceHistory: (...args: Parameters<typeof api.updateWorkspaceHistory>) => api.updateWorkspaceHistory(...args),
  getFavorites: () => api.getFavorites(),
  setFavorite: (path: string, present: boolean) => api.setFavorite(path, present),
  moveFavorite: (...args: Parameters<typeof api.moveFavorite>) => api.moveFavorite(...args),
  getRecent: () => api.getRecent(),
  recordRecent: (path: string) => api.recordRecent(path),
  removeRecent: (path: string) => api.removeRecent(path),
  clearRecent: () => api.clearRecent(),
  docStyleGet: (path: string) => api.docStyleGet(path),
  docStyleSet: (path: string, styleJson: string) => api.docStyleSet(path, styleJson),
  fileRename: (...args: Parameters<typeof api.fileRename>) => api.fileRename(...args),
  trashDocument: (reviewed: Parameters<typeof api.trashDocument>[0]) => api.trashDocument(reviewed),
  readDocument: (path: string) => api.readDocument(path),
  importImage: (src: string, dir: string) => api.importImage(src, dir),
  saveImageBytes: (...args: Parameters<typeof api.saveImageBytes>) => api.saveImageBytes(...args),
  writeDocument: (
    path: string,
    text: string,
    meta: { hadBom: boolean; crlf: boolean },
    expected: Parameters<typeof api.writeDocument>[3],
  ) => api.writeDocument(path, text, meta, expected),
  scanWorkspace: (root: string) => api.scanWorkspace(root),
  saveSession: (session: Parameters<typeof api.saveSession>[0]) => api.saveSession(session),
  draftSave: (draft: Parameters<typeof api.draftSave>[0]) => api.draftSave(draft),
  draftLoad: (key: string) => api.draftLoad(key),
  draftClear: (key: string) => api.draftClear(key),
  draftList: () => api.draftList(),
  snapshotBackup: (path: string, text: string) => api.snapshotBackup(path, text),
  setAssetScope: (path: string, recursive: boolean) => api.setAssetScope(path, recursive),
  watchPaths: (files: string[], dirs: string[]) => api.watchPaths(files, dirs),
  bookmarkList: (path: string) => api.bookmarkList(path),
  bookmarkSet: (...args: Parameters<typeof api.bookmarkSet>) => api.bookmarkSet(...args),
  bookmarkReplace: (...args: Parameters<typeof api.bookmarkReplace>) => api.bookmarkReplace(...args),
  patchSettings: isInApp() ? (patch: Parameters<typeof api.patchSettings>[0]) => api.patchSettings(patch) : undefined,
  backlinks: (root: string, path: string) => api.backlinks(root, path),
  commentList: (path: string) => api.commentList(path),
  commentAdd: (path: string, lineNo: number, text: string) => api.commentAdd(path, lineNo, text),
  commentUpdate: (...args: Parameters<typeof api.commentUpdate>) => api.commentUpdate(...args),
  commentResolve: (...args: Parameters<typeof api.commentResolve>) => api.commentResolve(...args),
  commentRemove: (...args: Parameters<typeof api.commentRemove>) => api.commentRemove(...args),
  commentReanchor: (path: string, updates: Array<[number, number]>) => api.commentReanchor(path, updates),
  baselineGet: (path: string) => api.baselineGet(path),
  baselineWrite: (...args: Parameters<typeof api.baselineWrite>) => api.baselineWrite(...args),
  speakStart: (text: string, rate: number, voice: string) => api.speakStart(text, rate, voice),
  speakStop: () => api.speakStop(),
  speakStatus: () => api.speakStatus(),
};

export type PdfExportOptions = PdfOptions;

/** 이 창의 역할 — "main"(전체 UI·세션 소유) 또는 "doc-*"(단일 문서 보조 창). */
function windowLabel(): string {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return "main";
  try {
    const meta = (
      window as unknown as {
        __TAURI_INTERNALS__: { metadata?: { currentWindow?: { label?: string } } };
      }
    ).__TAURI_INTERNALS__;
    return meta.metadata?.currentWindow?.label ?? "main";
  } catch {
    return "main";
  }
}

/** 보조 창이면 ?file= 경로. */
function fileParam(): string | null {
  if (typeof window === "undefined") return null;
  const m = /[?&]file=([^&]+)/.exec(window.location.search);
  return m ? decodeURIComponent(m[1]) : null;
}

export function App(): JSX.Element {
  const store = useMemo(() => new AppStore(ioAdapter), []);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const editorHost = useRef<HTMLDivElement | null>(null);
  const appRoot = useRef<HTMLDivElement | null>(null);
  const editorView = useRef<EditorView | null>(null);
  const exportRunning = useRef(false);
  /** 닫기 확인 진행 중인 콜백(창 닫기·탭 닫기 공용). */
  const [closeAsk, setCloseAsk] = useState<((proceed: boolean) => void) | null>(null);
  const [closeTargets, setCloseTargets] = useState<string[] | null>(null);
  const closeInFlight = useRef(false);
  const closeMounted = useRef(true);
  const closePrompt = useRef<((proceed: boolean) => void) | null>(null);
  const askToClose = useCallback((ids: string[] | null): Promise<boolean> => {
    if (!closeMounted.current || closePrompt.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const complete = (proceed: boolean) => {
        if (closePrompt.current !== complete) return;
        closePrompt.current = null;
        setCloseAsk((current: typeof closeAsk) => (current === complete ? null : current));
        setCloseTargets(null);
        resolve(proceed);
      };
      closePrompt.current = complete;
      setCloseTargets(ids); setCloseAsk(() => complete);
    });
  }, []);
  useEffect(() => {
    closeMounted.current = true;
    return () => { closeMounted.current = false; closePrompt.current?.(false); };
  }, []);
  const [quitRound, setQuitRound] = useState<number | null>(null);
  const quitRoundRef = useRef<number | null>(null);
  const [quitWaiting, setQuitWaiting] = useState(false);
  const quitDiscardedIds = useRef(new Set<string>());
  const appColumns = useRef<HTMLDivElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [templatePicker, setTemplatePicker] = useState<{ initialId?: string } | null>(null);
  const [wsSearchOpen, setWsSearchOpen] = useState(false);
  const [wsSearchQuery, setWsSearchQuery] = useState("");
  const [graphOpen, setGraphOpen] = useState(false);
  const [documentLinks, setDocumentLinks] = useState<DocumentEdge[]>([]);
  const graphRequest = useRef<Promise<void> | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphReload, setGraphReload] = useState(0);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [brokenOpen, setBrokenOpen] = useState(false);
  const [viewer, setViewer] = useState<{
    images: DocumentImage[]; index: number; view: EditorView; current: () => boolean;
  } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  // 내보내기 토글·옵션은 설정에 산다 — 재시작에도 유지(Word 인쇄 설정 기억).
  const setExportPageNumbers = (v: boolean) => updateSettings(store, { exportPageNumbers: v });
  const setExportHeader = (v: boolean) => updateSettings(store, { exportHeader: v });
  const [symbolOpen, setSymbolOpen] = useState(false);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  /** 메모를 작성하기 시작한 문서·경로·내용·위치를 고정한다. */
  const [commentAddTarget, setCommentAddTarget] = useState<{
    id: string; path: string; title: string; lineNo: number; doc: Tab["state"]["doc"];
  } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [fmOpen, setFmOpen] = useState(false);
  /** 이미지 설명 편집(칩 클릭 위치 → 그 이미지). */
  const [imageEdit, setImageEdit] = useState<InlineLinkEdit | null>(null);
  const [headingRename, setHeadingRename] = useState<{
    from: number;
    to: number;
    title: string;
    stem: string;
    linkCount: number;
    /** 제목이 속한 문서 경로(같은 문서 링크 판별·디스크 갱신 제외용). */
    path: string | null;
  } | null>(null);
  const openImageEdit = useCallback((pos: number) => {
    const view = store.view;
    const image = view ? findImageAt(view.state, pos) : null;
    if (view && image) setImageEdit(captureInlineLinkEdit(view, image.from, image.to));
  }, [store]);
  useEffect(() => () => imageEdit?.finish(), [imageEdit]);
  /** 참조 보기 — 옆에 고정한 탭(읽기 전용 iframe 렌더). */
  const [pinnedTabId, setPinnedTabId] = useState<string | null>(null);
  const [trackOpen, setTrackOpen] = useState(false);
  const [trackAction, setTrackAction] = useState<"start" | "accept" | "stop" | null>(null);
  // 세션 복원으로 스토어가 지정하면 화면에 반영.
  useEffect(() => {
    if (store.pinnedTabId && store.pinnedTabId !== pinnedTabId) setPinnedTabId(store.pinnedTabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.pinnedTabId]);

  const lang: Lang = useMemo(() => {
    if (state.settings.language === "ko") return "ko";
    if (state.settings.language === "en") return "en";
    return detectBrowserLang();
  }, [state.settings.language]);
  const t = useMemo(() => makeT(lang), [lang]);

  // — 모달이 열려 있으면 에디터로 키보드 포커스가 새지 않게(의도치 않은
  //    입력·Tab 탐색 차단). 검색 바는 에디터 조작이 함께 일어나야 하므로 제외. —
  // 오버레이 단일 원천 — 에디터 inert와 초기 포커스·Tab 순환·닫힘 복귀가
  // modalOpen의 같은 목록을 공유한다. 32차까지 세 목록이 따로 놀아
  // 그래프·검수 등 10종이 inert·트랩을 빠졌다 — 새 오버레이는 여기만 추가.
  // 검색 바는 제외 — 열려도 편집(찾으며 고치기 흐름). 기호판 연속 삽입도
  // 프로그램 삽입이라 inert와 무관하다.
  const [sidebarModalOpen, setSidebarModalOpen] = useState(false);
  const [contextModalOpen, setContextModalOpen] = useState(false);
  const interactiveOverlayOpen = !!(
    sidebarModalOpen ||
    contextModalOpen ||
    closeAsk ||
    settingsOpen ||
    styleOpen ||
    printOpen ||
    shortcutsOpen ||
    statsOpen ||
    paletteOpen ||
    templatePicker !== null ||
    wsSearchOpen ||
    versionsOpen ||
    backlinksOpen ||
    brokenOpen ||
    diffOpen ||
    graphOpen ||
    fmOpen ||
    reviewOpen ||
    commentsOpen ||
    trackOpen ||
    symbolOpen ||
    tableDialogOpen ||
    viewer !== null ||
    commentAddTarget !== null ||
    imageEdit !== null ||
    state.exportKind !== null
  );
  const overlayOpen = interactiveOverlayOpen || state.tabs.some((x) => x.conflict !== null);
  const modalOpen = overlayOpen || state.busy !== null || quitRound !== null;
  const commandBlocked = useRef(false);
  commandBlocked.current = modalOpen || !state.ready;
  const closeBlocked = useRef(false);
  // 이미 열린 대화상자의 응답 콜백을 종료 확인으로 덮어쓰지 않는다.
  closeBlocked.current = interactiveOverlayOpen || state.busy !== null || !state.ready;
  useEffect(() => {
    if (editorHost.current) editorHost.current.inert = modalOpen;
    if (store.splitView) store.splitView.dom.inert = modalOpen;
    if (appColumns.current) appColumns.current.inert = quitRound !== null;
  }, [modalOpen, quitRound, store]);

  const focusEditor = useCallback(() => editorView.current?.focus(), []);
  useOverlayFocus(appRoot, modalOpen, focusEditor);

  // — 초기화 —
  useEffect(() => {
    store.phrases = { bigDocSource: t.bigDocSource };
    setPhrases({
      editorLabel: t.editorLabel,
      mathError: t.mathError,
      diagramError: t.diagramError,
      imgMissing: t.imgMissing,
      imgLoadBlocked: t.imgLoadBlocked,
      linkOpen: t.linkOpen,
      linkOpenFailed: t.linkOpenFailed,
      saveFailed: t.saveFailed,
      settingsSaveFailed: t.settingsSaveFailed,
      trackRestoreDeleted: t.trackRevert,
      speakStartedDoc: t.speakStartedDoc,
      speakStartedSel: t.speakStartedSel,
      speakFailed: t.speakFailed,
      clipboardReadFailed: t.ctxPasteBlocked,
      clipboardWriteFailed: t.clipboardWriteFailed,
      clipboardTargetChanged: t.clipboardTargetChanged,
      clipboardHtmlTooLarge: t.clipboardHtmlTooLarge,
      clipboardHtmlFailed: t.clipboardHtmlFailed,
    });
    let disposed = false;
    initBridge();
    // 앱 셸 첫 페인트가 나왔다 — index.html의 부트 스플래시를 치운다.
    document.getElementById("iyagi-boot")?.remove();
    store.state.ready = false;
    (async () => {
      try {
        const settings = await api.getSettings();
        if (!disposed) store.acceptSettings(settings);
      } catch {
        /* 브라우저 개발 — 기본값 */
      }
      // 정리된 실행(StrictMode 이중 실행의 첫 번째)은 여기서 멈춘다 — 이어 가면
      // 복원 대신 빈 새 탭을 만들어 활성화하고 세션에 저장까지 했다.
      if (disposed) return;
      // 보조 창(doc-*)은 세션을 복원하지 않고 지정 파일만 — main이 세션을 소유.
      const isAux = windowLabel() !== "main";
      const file = fileParam();
      if (isAux && file) {
        await store.openPath(file);
      } else {
        try {
          const session = await api.getSession();
          if (!disposed) await store.restoreSession(session ?? store.buildSession());
        } catch (e) {
          if (isInApp()) store.toast(String(e), "error");
          if (!disposed) await store.restoreSession(store.buildSession());
        }
      }
      if (disposed) return;
      try {
        const pending = await api.takePendingFiles();
        for (const p of pending) await store.openPath(p);
      } catch {
        /* 무시 */
      }
      if (store.state.tabs.length === 0) store.newTab();
      // 참조 보기 복원 — 경로로 탭 id 해소.
      if (store.pendingPinnedPath) {
        const t = store.findSessionTab(store.pendingPinnedPath);
        if (t) store.pinnedTabId = t.id;
        store.pendingPinnedPath = null;
      }
      // 잠금 복원 — 경로로 탭에 적용.
      for (const lp of store.pendingLockedPaths) {
        const t = store.findSessionTab(lp);
        if (t) store.setLocked(t.id, true);
      }
      store.pendingLockedPaths.clear();
      store.state.ready = true;
      store.activate(store.state.activeId ?? store.state.tabs[0]?.id ?? "");
      void api.appReady().catch(() => {});
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 창 위치·크기 추적 — 세션 복원용(디바운스 저장).
  useEffect(() => {
    if (!isInApp()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const record = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void webviewWindowApi().then(async (win) => {
          try {
            const pos = await win.outerPosition();
            const size = await win.innerSize();
            const scale = await win.scaleFactor();
            store.setWindowRect({
              x: pos.x / scale,
              y: pos.y / scale,
              width: size.width / scale,
              height: size.height / scale,
            });
          } catch {
            /* 최소화 등 */
          }
        });
      }, 800);
    };
    void (async () => {
      const ev = await import("@tauri-apps/api/event");
      // 이 창의 이동·리사이즈 이벤트(권한은 core:event:default — listen).
      await ev.listen("tauri://move", record).catch(() => {});
      await ev.listen("tauri://resize", record).catch(() => {});
    })();
    record();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [store]);

  // 이미지 폭 조절 → 사이드카 / 이미지 클릭 → 확대 뷰어(원문 불변).
  useEffect(() => {
    // 노트 임베드 ![[이름]] — 내용 제공(읽기 실패는 위젯이 끊김 표시)과 클릭 열기.
    setEmbedContentHandler(async (path) => {
      try {
        const doc = await api.readDocument(path);
        return stripFrontMatter(doc.text);
      } catch {
        return null;
      }
    });
    setEmbedOpenHandler((path) => { void store.openPath(path); });
    setImageResizeHandler((src, pct) => store.setImageWidth(src, pct));
    setImageViewerHandler((view, pos) => {
      const tab = store.active;
      if (view !== store.view || !tab) return;
      const { id, path } = tab;
      const doc = view.state.doc;
      const config = view.state.field(previewConfigField);
      const images = documentImages(doc.toString(), config.baseDir).filter((image) =>
        config.remoteImages || !/^https?:/i.test(image.src) || (image.from <= pos && pos < image.to));
      const index = images.findIndex((image) => image.from <= pos && pos < image.to);
      if (index < 0 || !config.showImages) return;
      setViewer({ images, index, view, current: () => {
        const now = view.state.field(previewConfigField, false);
        return !!now && store.view === view && view.dom.isConnected && view.state.doc === doc &&
          store.active?.id === id && store.active.path === path &&
          now.baseDir === config.baseDir && now.remoteImages === config.remoteImages && now.showImages;
      } });
    });
    setFrontMatterEditHandler(() => setFmOpen(true));
    // 이미지 '설명 추가' 칩 — 그 이미지의 대체 텍스트 편집(69차 대화상자 재사용).
    setImageCaptionHandler((_src, pos) => openImageEdit(pos));
    setTableWidthsSaveHandler((lineNo, key, widths) => store.setTableWidths(lineNo, key, widths));
    setTagClickHandler((tag) => {
      setWsSearchQuery(tag);
      setWsSearchOpen(true);
    });
    setTableHeaderClickHandler((col, reset) => {
      const view = store.view;
      const tab = store.active;
      if (!view || !tab || tab.mode === "read") return;
      // 클릭한 열의 데이터 행 셀 안쪽으로 커서 → tableAlignColumn의 기준이 된다.
      const t = fmt.tableAround(view);
      if (!t) return;
      const dataLine = Math.min(t.lastLine, t.firstLine + 2);
      const line = view.state.doc.line(dataLine);
      let pipes = 0;
      let pos = line.to;
      for (let i = 0; i < line.text.length; i++) {
        if (line.text[i] === "|" && line.text[i - 1] !== "\\") {
          if (pipes === col + 1) {
            pos = line.from + i + 1;
            break;
          }
          pipes += 1;
        }
      }
      view.dispatch({ selection: { anchor: Math.min(pos, line.to) } });
      // 순환: 현재 정렬 읽어서 다음 단계로. reset(Alt+클릭)면 none.
      const sep = view.state.doc.line(t.firstLine + 1).text;
      const re = new RegExp(`(?:^\|)|(?:\|)\s*(:?)(-{3,})(:?)\s*(?=\|)`, "g");
      let m: RegExpExecArray | null;
      let cur: "none" | "left" | "center" | "right" = "none";
      let idx = 0;
      while ((m = re.exec(sep))) {
        if (idx === col) {
          cur = m[1] && m[3] ? "center" : m[3] ? "right" : m[1] ? "left" : "none";
          break;
        }
        idx += 1;
      }
      const order = ["none", "left", "center", "right"] as const;
      const next = reset ? "none" : order[(order.indexOf(cur) + 1) % order.length];
      fmt.tableAlignColumn(view, next);
      view.focus();
    });
    return () => {
      setImageResizeHandler(null);
      setImageViewerHandler(null);
      setFrontMatterEditHandler(null);
      setImageCaptionHandler(null);
      setTableHeaderClickHandler(null);
      setTableWidthsSaveHandler(null);
      setTagClickHandler(null);
    };
  }, [store, openImageEdit]);

  // — 에디터 뷰 수명(탭 전환은 setState) —
  useEffect(() => {
    if (!editorHost.current || editorView.current) return;
    const view = new EditorView({ parent: editorHost.current });
    editorView.current = view;
    store.view = view;
    // 개발 진단용 — 브라우저 콘솔/테스트에서 뷰에 직접 접근(프로덕션 제외).
    if (import.meta.env.DEV) (window as unknown as { __iyagiView?: unknown }).__iyagiView = view;
    store.hostEl = editorHost.current;
    setViewListener((update) => store.onDocChanged(update));
    setImageImportHandler((view, files) => { void store.importImages(view, files); });
    setClipboardNoticeHandler((text, kind) => store.toast(text, kind));
    const tab = store.active;
    if (tab) view.setState(tab.state);
    store.applyConfig();
    return () => {
      setViewListener(null);
      setImageImportHandler(null);
      setClipboardNoticeHandler(null);
      view.destroy();
      editorView.current = null;
      store.view = null;
      store.hostEl = null;
    };
  }, [store]);

  // — 저장·내보내기 —
  const saveAs = useCallback(async (): Promise<boolean> => {
    const tab = store.active;
    if (!tab) return false;
    // 기본 파일명 — 프런트매터 제목 우선(57차와 같은 규칙), 금지문자 치환.
    const fmTitle = frontMatterMeta(tab.state.doc.toString())?.title ?? "";
    const name = (fmTitle || (tab.path ? tab.title : "untitled"))
      .replace(/\.(md|markdown)$/i, "")
      .replace(/[\/:*?"<>|]/g, "-");
    const path = await pickSave(`${name}.md`, "md");
    if (!path) return false;
    const ok = await store.saveDocument(tab.id, path);
    if (ok) store.toast(t.savedToast);
    return ok;
  }, [store, t]);

  const saveActive = useCallback(async () => {
    const tab = store.active;
    if (!tab) return;
    const ok = tab.path ? await store.saveActive() : await saveAs();
    if (ok) store.toast(t.savedToast);
  }, [store, t, saveAs]);

  const readBytesForExport = useCallback(
    async (p: string): Promise<Uint8Array | null> => {
      try {
        const bytes = await api.readFileBytes(p);
        return new Uint8Array(bytes);
      } catch {
        return null;
      }
    },
    [],
  );

  /** 커서가 있는 제목 이름 바꾸기 흐름 — 링크 수를 세고 대화상자를 연다. */
  const openRenameHeadingFlow = async (): Promise<void> => {
    const view = store.view;
    const tab = store.active;
    if (!view || !tab) return;
    const heading = headingAtCursor(view.state);
    if (!heading) {
      store.toast(t.renameHeadingNoHeading, "error");
      return;
    }
    const stem = (tab.path ? tab.title : "untitled").replace(/\.md$/i, "");
    const text = view.state.doc.toString();
    let count = countHeadingLinks(text, stem, heading.title);
    // 다른 파일의 링크 수 — 디스크 읽기 상한 300(대화상자 안내값).
    const walkFiles = async (nodes: TreeNode[]): Promise<string[]> => {
      const out: string[] = [];
      for (const n of nodes) {
        if (n.kind === "dir") out.push(...await walkFiles(n.children ?? []));
        else out.push(n.path);
      }
      return out;
    };
    let scanned = 0;
    for (const p of await walkFiles(store.state.tree)) {
      if (scanned >= 300) break;
      if (p === tab.path) continue;
      scanned++;
      let doc;
      try { doc = await api.readDocument(p); } catch { continue; }
      count += countHeadingLinks(doc.text, stem, heading.title);
    }
    setHeadingRename({ ...heading, stem, linkCount: count, path: tab.path });
  };

  const runExport = useCallback(
    async (kind: ExportKind, opts: PdfExportOptions, reviewed?: ExportSnapshot, reviewedHtml?: string): Promise<ExportResult> => {
      store.syncActiveState();
      const tab = store.active;
      if (!tab && !reviewed) return { status: "failed", message: t.emptyNoDoc };
      if (exportRunning.current || store.state.busy !== null) return { status: "failed", message: t.commandBlocked };
      exportRunning.current = true;
      store.setBusy(t.exportPreparing);
      try {
        const captured = reviewed ?? captureExportSnapshot(tab!, {
          workspace: store.state.workspace,
          theme: store.state.theme,
          pageNumbers: store.state.settings.exportPageNumbers,
          header: store.state.settings.exportHeader,
          wikiIndex: store.wikiIndex,
          lang,
        }, kind === "docx");
        // 노트 임베드 ![[이름]] 인라인 — 모든 형식이 같은 마크다운을 쓴다.
        const snapshot = await applyEmbeds(captured, (path) =>
          api.readDocument(path).then((doc) => doc.text).catch(() => null));
        const {
          text, baseDir, wikiResolve, fm, metaTitle, metaAuthor, name, docTitle,
          style, docxStyle, imageWidths, tableWidths, comments, theme, pageNumbers, header,
        } = snapshot;
        const pdfOptions = { ...opts };
        const ext = kind;
        const out = await pickSave(`${name}.${ext}`, ext);
        if (!out) return { status: "cancelled" };
        // markdown-it(±footnote)은 내보내기에서만 쓴다 — 동적 로드로 메인
        // 청크에서 빼 시작 로딩을 줄인다.
        const { buildDocxManifest, buildExportHtml, renderExportBody } = await import("./export/html");

        if (kind === "html") {
          const html = await buildExportHtml(snapshot.markdown, {
            title: docTitle,
            baseDir,
            theme,
            style,
            imageWidths,
            tableWidths,
            frontLists: { toc: !!fm?.toc, lof: !!fm?.lof, lot: !!fm?.lot },
            lang: snapshot.lang,
            externalLinksNewTab: true,
            readBytes: readBytesForExport,
            wikiResolve,
          });
          await api.writeExportFile(out, html);
        } else if (kind === "pdf") {
          const html = reviewedHtml ?? await buildExportHtml(snapshot.markdown, snapshotHtmlOptions(snapshot, readBytesForExport, pdfOptions));
          await api.exportPdf(html, { ...pdfOptions, pageNumbers }, out);
        } else if (kind === "epub") {
          // Share HTML export's caption/width/sanitization pipeline; keep image
          // paths for the Rust packager to embed into the EPUB.
          const body = await renderExportBody(snapshot.markdown, {
            title: docTitle,
            baseDir,
            theme: "light",
            imageWidths,
            tableWidths,
            lang: snapshot.lang,
            inlineImages: false,
            wikiResolve,
          });
          const chapters = epubChapterInputs(splitEpubChapters(body));
          // 표지 — 문서의 첫 로컬 이미지. 프런트매터 cover: false면 끔.
          const coverPath = fm?.cover === false ? null : firstEpubLocalImage(body, baseDir);
          await api.exportEpub(
            {
              chapters,
              title: docTitle,
              author: metaAuthor || "IYAGI Markdown",
              language: snapshot.lang,
              css: EPUB_CSS,
              coverPath,
              baseDir,
            },
            out,
          );
        } else {
          const manifest = await buildDocxManifest(text);
          // 문서별 스타일 → DOCX 기본 서체(폰트·크기).
          manifest.style = docxStyle;
          manifest.imageWidths = imageWidths;
          manifest.tableWidths = tableWidths;
          manifest.comments = comments;
          if (metaTitle) manifest.title = metaTitle;
          if (metaAuthor) manifest.author = metaAuthor;
          manifest.frontLang = snapshot.lang;
          if (fm?.columns && fm.columns > 1) manifest.columns = fm.columns;
          if (fm?.toc) manifest.toc = true;
          if (fm?.lof) manifest.lof = true;
          if (fm?.lot) manifest.lot = true;
          if (fm?.header) manifest.headerTitle = fm.header;
          else if (header) manifest.headerTitle = docTitle;
          if (fm?.footer) manifest.footerText = fm.footer;
          await api.exportDocx(text, manifest, out, baseDir);
        }
        // 마지막 옵션 저장(재시작 유지) — PDF 옵션은 pdf에만 있고 docx는 토글만.
        if (kind === "pdf") {
          updateSettings(store, {
            exportPaper: pdfOptions.paper,
            exportLandscape: pdfOptions.orientation === "landscape",
            exportMarginMm: pdfOptions.marginMm,
            exportScale: pdfOptions.scale,
          });
        }
        store.toast(t.f.exportDone(out.split(/[\\/]/).at(-1) || `${name}.${ext}`));
        return { status: "saved", path: out };
      } catch (e) {
        return { status: "failed", message: e instanceof Error ? e.message : String(e) };
      } finally {
        exportRunning.current = false;
        store.setBusy(null);
      }
    },
    [store, t, lang, readBytesForExport],
  );

  /** Single and batch closes own the entire flush/confirmation operation. */
  const closeTabsBatch = useCallback(
    async (tabs: Tab[]) => {
      if (tabs.length === 0) return;
      if (closeInFlight.current || closePrompt.current || quitRoundRef.current !== null) {
        store.toast(t.commandBlocked); return;
      }
      closeInFlight.current = true;
      const ids = [...new Set(tabs.map((tab) => tab.id))];
      let closed = false;
      try {
        if (!(await store.flushDocStyles(ids))) return;
        if (!closeMounted.current) return;
        store.syncActiveState();
        const current = () => store.state.tabs.filter((tab) => ids.includes(tab.id));
        if (current().some((tab) => tab.dirty) && !(await askToClose(ids))) return;
        if (!closeMounted.current) return;
        // A confirmation only approves the content it actually saved/discarded.
        if (current().some((tab) => tab.dirty)) { store.toast(t.closeChanged, "error"); return; }
        for (const tab of current()) store.closeTab(tab.id);
        closed = true;
      } catch (error) { store.toast(String(error), "error"); }
      finally {
        if (!closed) restoreUnclosedDrafts(store, ids);
        closeInFlight.current = false;
      }
    },
    [store, askToClose, t],
  );
  const closeTabWithConfirm = useCallback((tab: Tab) => closeTabsBatch([tab]), [closeTabsBatch]);

  // — 메뉴/단축키 동작 —
  const runMenu = useCallback(
    (id: string) => {
      if (id.startsWith("recent:")) {
        void store.openPath(id.slice("recent:".length));
        return;
      }
      switch (id) {
        case "settings":
          setSettingsOpen(true);
          break;
        case "doc-style":
          setStyleOpen(true);
          break;
        case "shortcuts":
          setShortcutsOpen(true);
          break;
        case "command-palette":
          setPaletteOpen(true);
          break;
        case "workspace-search":
          setWsSearchOpen(true);
          break;
        case "new-tab":
          store.newTab();
          break;
        case "open":
          void pickOpenFile().then((p) => {
            if (p) void store.openPath(p);
          });
          break;
        case "open-folder":
          void pickOpenFolder().then((d) => {
            if (d) void store.openWorkspace(d);
          });
          break;
        case "clear-recent":
          void store.clearRecent();
          break;
        case "save":
          void saveActive();
          break;
        case "save-as":
          void saveAs();
          break;
        case "insert-symbols":
          setSymbolOpen(true);
          break;
        case "print":
          setPrintOpen(true);
          break;
        case "export-html":
        case "export-pdf":
        case "export-docx":
        case "export-epub":
          store.setExportKind(id.slice("export-".length) as ExportKind);
          break;
        case "reopen-closed-tab":
          void store.reopenClosedTab();
          break;
        case "close-tab": {
          const tab = store.active;
          if (tab) void closeTabWithConfirm(tab);
          break;
        }
        case "find":
          store.setSearchOpen(true);
          break;
        case "navigate-back":
        case "navigate-forward":
          store.navigateHistory(id === "navigate-forward");
          break;
        case "find-next":
        case "find-prev": {
          // ⌘G/⇧⌘G — 메뉴 가속기가 webview보다 먼저 소모하므로 여기서 실행
          // (그동안 케이스가 없어 메뉴·단축키가 무반응이었다).
          const v = editorView.current;
          const q = v ? searchStateOf(v.state).query : null;
          if (v && q?.text) {
            findNext(v, id === "find-next");
          } else {
            store.setSearchOpen(true); // 쿼리 없음 — 패널부터
          }
          break;
        }
        case "replace":
          store.setSearchOpen(true);
          break;
        case "versions":
          setVersionsOpen(true);
          break;
        case "backlinks":
          setBacklinksOpen(true);
          break;
        case "broken-links":
          setBrokenOpen(true);
          break;
        case "mode-edit":
          store.setMode("edit");
          break;
        case "mode-read":
          store.setMode(store.active?.mode === "read" ? "edit" : "read");
          break;
        case "mode-source":
          store.setMode(store.active?.mode === "source" ? "edit" : "source");
          break;
        case "toggle-sidebar":
          store.setSidebar(!store.state.sidebarOpen);
          break;
        case "toggle-toc":
          store.setToc(!store.state.tocOpen);
          break;
        case "zoom-in":
          zoomBy(store, 1);
          break;
        case "zoom-out":
          zoomBy(store, -1);
          break;
        case "zoom-reset":
          updateSettings(store, { fontSize: 15 });
          break;
        case "next-tab":
          store.cycleTabs(true);
          break;
        case "prev-tab":
          store.cycleTabs(false);
          break;
        default:
          break;
      }
    },
    [store, saveActive, saveAs, closeTabWithConfirm],
  );
  const handleMenu = useMemo(() => guardAppCommands(
    () => commandBlocked.current || quitRoundRef.current !== null || store.state.busy !== null,
    runMenu,
    () => store.toast(t.commandBlocked),
  ), [runMenu, store, t.commandBlocked]);

  // — 이벤트 구독 —
  useEffect(() => {
    const unlistens: (() => void)[] = [];
    let disposed = false;
    const keep = (p: Promise<{ (): void } | void | undefined>) => {
      void p.then((u) => {
        if (u) {
          if (disposed) u();
          else unlistens.push(u as () => void);
        }
      });
    };

    keep(onMenu((id) => {
      if (quitRoundRef.current === null) handleMenu(id);
    }));
    keep(
      onFsEvent((e) => {
        store.externalChange(e.path, e.kind);
        invalidateLinkPreviews(e.path); // 호버 미리보기 캐시도 함께 무효화
      }),
    );
    keep(onOpenFiles(async (paths) => {
      for (const p of paths) await store.openPath(p);
    }));
    keep(onBaselineChanged((path) => {
      if (!disposed) void store.refreshBaseline(path);
    }).then((unlisten) => {
      if (!disposed) {
        for (const path of new Set(store.state.tabs.map((tab) => tab.path))) if (path) void store.refreshBaseline(path);
      }
      return unlisten;
    }).catch((error: unknown) => {
      if (!disposed) store.toast(`${t.trackLoadFailed}: ${String(error)}`, "error");
    }));
    keep(onBookmarksChanged((path) => {
      if (!disposed) void store.refreshBookmarks(path);
    }).then((unlisten) => {
      if (!disposed) {
        for (const path of new Set(store.state.tabs.map((tab) => tab.path))) if (path) void store.refreshBookmarks(path);
      }
      return unlisten;
    }).catch((error: unknown) => {
      if (!disposed) store.toast(`${t.bookmarksSyncFailed}: ${String(error)}`, "error");
    }));
    keep(onCommentsChanged((path) => {
      if (!disposed) void store.refreshComments(path);
    }).then((unlisten) => {
      if (!disposed) {
        for (const path of new Set(store.state.tabs.map((tab) => tab.path))) {
          if (path) void store.refreshComments(path);
        }
      }
      return unlisten;
    }).catch((error: unknown) => {
      if (!disposed) store.toast(`${t.commentsSyncFailed}: ${String(error)}`, "error");
    }));
    keep(onSettingsChanged((snapshot) => {
      if (!disposed) store.acceptSettings(snapshot);
    }).then((unlisten) => {
      // 구독 전에 발생한 변경은 최신 스냅샷으로 보충한다.
      if (isInApp() && !disposed) {
        void api.getSettings().then((snapshot) => {
          if (!disposed) store.acceptSettings(snapshot);
        }).catch((error: unknown) => {
          if (!disposed) store.toast(`${t.settingsSyncFailed}: ${String(error)}`, "error");
        });
      }
      return unlisten;
    }).catch((error: unknown) => {
      if (!disposed) store.toast(`${t.settingsSyncFailed}: ${String(error)}`, "error");
    }));
    // 구독을 먼저 연 뒤 조회해 시작 중 변경을 놓치지 않는다.
    keep(onRecentChanged((snapshot) => store.acceptRecent(snapshot)).then((unlisten) => {
      if (!disposed) void store.loadRecent();
      return unlisten;
    }).catch((error: unknown) => {
      if (!disposed) {
        store.toast(`${t.recentSyncFailed}: ${String(error)}`, "error");
        void store.loadRecent();
      }
    }));

    keep(onWorkspaceHistoryChanged((snapshot) => store.workspaceHistory.accept(snapshot)).then((unlisten) => {
      if (!disposed) void store.workspaceHistory.load();
      return unlisten;
    }).catch((error: unknown) => {
      if (!disposed) {
        store.toast(`${t.workspaceHistorySyncFailed}: ${String(error)}`, "error");
        void store.workspaceHistory.load();
      }
    }));
    keep(onFavoritesChanged((snapshot) => store.acceptFavorites(snapshot)).then((unlisten) => {
      if (!disposed) void store.loadFavorites();
      return unlisten;
    }).catch((error: unknown) => {
      if (!disposed) {
        store.toast(`${t.favoritesSyncFailed}: ${String(error)}`, "error");
        void store.loadFavorites();
      }
    }));

    // 시스템 테마 추종(auto일 때).
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => {
      if (store.state.settings.theme === "auto") store.setTheme(resolveTheme(store.state.settings));
    };
    mq.addEventListener("change", onTheme);

    // 브라우저 폴백 단축키(macOS 메뉴 가속기가 없는 환경).
    const onKey = (e: KeyboardEvent) => {
      handleAppShortcut(e, handleMenu);
    };
    window.addEventListener("keydown", onKey);

    // 파일 드래그 앤 드롭(Tauri 경로 이벤트).
    if (isInApp()) {
      void import("@tauri-apps/api/event").then(async (ev) => {
        const u = await ev.listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
          if (commandBlocked.current || quitRoundRef.current !== null || store.state.busy !== null) {
            store.toast(t.commandBlocked);
            return;
          }
          const paths = e.payload.paths;
          for (const p of paths.filter((x) => /\.(md|markdown)$/i.test(x))) {
            void store.openPath(p);
          }
          // 이미지 드롭 — 문서 폴더 assets/ 로 복사해 커서에 삽입(Typora 방식).
          const imgs = paths.filter((x) => /\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i.test(x));
          if (imgs.length > 0) void importDroppedImages(imgs);
        });
        if (disposed) u();
        else unlistens.push(u);
      });
      // 더티 확인 공용 — ⌘W(창 닫기)·⌘Q(앱 종료)가 같은 절차를 탄다.
      // CloseConfirm이 저장 실패 시 false로 보류한다(25차 가드 상속).
      let resolveClose: ((ok: boolean) => void) | null = null;
      const confirmDirty = async (): Promise<boolean> => {
        if (disposed) return false;
        const dirty = store.state.tabs.filter((x) => x.dirty);
        if (dirty.length === 0) return true;
        if (closePrompt.current) return false;
        const pending = askToClose(null);
        const callback = closePrompt.current;
        resolveClose = callback;
        const ok = await pending;
        if (resolveClose === callback) resolveClose = null;
        if (ok && store.state.tabs.some((tab) => tab.dirty)) { store.toast(t.closeChanged, "error"); return false; }
        return ok;
      };
      let closingWindow = false;
      const flushBeforeClose = async (): Promise<boolean> => {
        store.setBusy(t.loading);
        try {
          await store.flushDrafts();
          await store.flushSettings();
          try {
            const win = await webviewWindowApi();
            const pos = await win.outerPosition();
            const size = await win.innerSize();
            const scale = await win.scaleFactor();
            const rect = {
              x: pos.x / scale, y: pos.y / scale,
              width: size.width / scale, height: size.height / scale,
            };
            if (windowLabel() === "main") store.setWindowRect(rect);
            else store.setAuxWindowRect(rect);
          } catch { /* 위치 기록 실패는 문서 저장과 무관하다. */ }
          await api.saveSession(store.buildSession());
          return true;
        } catch (e) {
          store.toast(String(e), "error");
          return false;
        } finally {
          store.setBusy(null);
        }
      };
      // Rust가 창을 순서대로 요청한다. 승인한 창은 전체 종료/취소까지 입력을 막는다.
      {
        let releaseWatch: (() => void) | null = null;
        let lastCancelled = -1;
        const releaseQuit = () => {
          const wasQuitting = quitRoundRef.current !== null;
          releaseWatch?.();
          releaseWatch = null;
          quitRoundRef.current = null;
          setQuitRound(null);
          setQuitWaiting(false);
          resolveClose?.(false);
          if (wasQuitting && !disposed) store.resumeAutosaves();
          if (quitDiscardedIds.current.size) {
            store.restoreDiscardedDocuments([...quitDiscardedIds.current]);
            quitDiscardedIds.current.clear();
          }
        };
        const cancelQuit = async (id: number) => {
          try {
            await api.quitReply(id, false);
          } catch (e) {
            store.toast(String(e), "error");
          }
          if (quitRoundRef.current === id) releaseQuit();
        };
        const prepareQuit = async (id: number) => {
          if (disposed || id <= lastCancelled || quitRoundRef.current === id) return;
          if (closingWindow || closeInFlight.current || closeBlocked.current || quitRoundRef.current !== null) {
            await api.quitReply(id, false);
            store.toast(t.quitBlocked);
            return;
          }
          quitRoundRef.current = id;
          setQuitRound(id);
          closingWindow = true;
          closeInFlight.current = true;
          let settled = false;
          try {
            await store.settleDocumentWrites();
            if (quitRoundRef.current !== id) return;
            settled = true;
            if (!(await confirmDirty())) {
              await cancelQuit(id);
              return;
            }
            if (quitRoundRef.current !== id) return;
            // 본문/경로/스타일이 flush 중 또는 승인 뒤 바뀌면 전체 종료를 보류한다.
            const unchanged = closingDocumentsUnchanged(store);
            if (!(await flushBeforeClose())) {
              await cancelQuit(id);
              return;
            }
            if (quitRoundRef.current !== id) return;
            if (!unchanged()) {
              store.toast(t.quitChanged, "error");
              await cancelQuit(id);
              return;
            }
            setQuitWaiting(true);
            releaseWatch = store.subscribe(() => {
              if (quitRoundRef.current === id && !unchanged()) {
                releaseWatch?.();
                releaseWatch = null;
                void cancelQuit(id);
                store.toast(t.quitChanged, "error");
              }
            });
            const accepted = await api.quitReply(id, true);
            if (!accepted && quitRoundRef.current === id) releaseQuit();
          } catch (e) {
            store.toast(String(e), "error");
            await cancelQuit(id);
          } finally {
            closingWindow = false;
            closeInFlight.current = false;
            if (!settled && quitRoundRef.current === null && !disposed) store.resumeAutosaves();
          }
        };
        unlistens.push(() => {
          const id = quitRoundRef.current;
          if (id !== null) void api.quitReply(id, false).catch(() => {});
          releaseQuit();
        });
        void import("@tauri-apps/api/event").then(async (ev) => {
          const uc = await ev.listen<number>("quit-cancelled", (event) => {
            lastCancelled = Math.max(lastCancelled, event.payload);
            if (quitRoundRef.current === event.payload) releaseQuit();
          });
          if (disposed) { uc(); return; }
          unlistens.push(uc);
          const uq = await ev.listen<number>("quit-requested", (event) => {
            void prepareQuit(event.payload).catch((e) => store.toast(String(e), "error"));
          });
          if (disposed) { uq(); return; }
          unlistens.push(uq);
          const pending = await api.quitPending();
          if (!disposed && pending !== null) await prepareQuit(pending);
        }).catch((e) => store.toast(String(e), "error"));
      }
      // 창 닫기 요청 — 미저장 확인·초안·스타일·세션 기록을 끝낸 뒤 닫는다.
      void webviewWindowApi().then(async (win) => {
        const u = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          if (closingWindow || closeInFlight.current || quitRoundRef.current !== null) return;
          if (closeBlocked.current) {
            store.toast(t.quitBlocked);
            return;
          }
          closingWindow = true;
          closeInFlight.current = true;
          let destroyed = false;
          const windowTargets = store.state.tabs.map((tab) => tab.id);
          try {
            await store.settleDocumentWrites();
            if (!(await confirmDirty())) return;
            const unchanged = closingDocumentsUnchanged(store);
            if (!(await flushBeforeClose())) return;
            if (disposed || !unchanged()) { store.toast(t.closeChanged, "error"); return; }
            await win.destroy();
            destroyed = true;
          } catch (e) {
            store.toast(String(e), "error");
          } finally {
            if (!destroyed) {
              store.resumeAutosaves();
              restoreUnclosedDrafts(store, windowTargets);
            }
            closingWindow = false;
            closeInFlight.current = false;
          }
        });
        if (disposed) u();
        else unlistens.push(u);
      });
    }

    return () => {
      disposed = true;
      for (const u of unlistens) u();
      mq.removeEventListener("change", onTheme);
      window.removeEventListener("keydown", onKey);
    };
  }, [store, handleMenu, saveActive, saveAs, askToClose, t]);

  // — Esc로 시트 닫기(macOS 앱 관례) — 확인 대화상자가 떠 있으면 비켜주고,
  // 에디터가 먼저 처리한 Esc(자동완성 닫기 등)는 존중한다.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (exportRunning.current) { e.preventDefault(); return; }
      if (closeAsk) return;
      if (templatePicker !== null) return; // 템플릿 창이 IME와 Escape를 직접 처리한다.
      if (state.exportKind) return; // 내보내기 시트가 진행 상태와 Escape를 함께 관리한다.
      if (styleOpen) {
        setStyleOpen(false);
        return;
      }
      if (printOpen) {
        setPrintOpen(false);
        return;
      }
      if (graphOpen) {
        setGraphOpen(false);
        return;
      }
      if (fmOpen) return; // 문서 정보 창이 입력 폐기 확인을 직접 처리한다.
      if (reviewOpen) {
        setReviewOpen(false);
        return;
      }
      if (statsOpen) {
        setStatsOpen(false);
        return;
      }
      // 나머지 오버레이의 Escape 안전망. 자체 처리한 키는 앞쪽의
      // defaultPrevented 검사로 제외하며 초안 폐기 확인이 있는 창은 위임한다.
      if (paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      if (wsSearchOpen) {
        setWsSearchOpen(false);
        return;
      }
      if (tableDialogOpen) return; // 표 삽입 창이 입력 폐기 확인을 직접 처리한다.
      if (symbolOpen) {
        setSymbolOpen(false);
        return;
      }
      if (shortcutsOpen) {
        setShortcutsOpen(false);
        return;
      }
      if (versionsOpen) {
        setVersionsOpen(false);
        return;
      }
      if (backlinksOpen) {
        setBacklinksOpen(false);
        return;
      }
      if (brokenOpen) {
        setBrokenOpen(false);
        return;
      }
      if (diffOpen) {
        setDiffOpen(false);
        return;
      }
      if (commentsOpen) return; // 패널이 진행 중 저장·편집 확인을 직접 처리한다.
      if (trackOpen) return; // 패널이 저장 중 닫기와 확인 취소를 처리한다.
      if (commentAddTarget !== null) return; // 입력을 버리는 확인은 대화상자가 담당한다.
      if (settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [
    closeAsk,
    state.exportKind,
    styleOpen,
    printOpen,
    graphOpen,
    fmOpen,
    reviewOpen,
    statsOpen,
    paletteOpen,
    templatePicker,
    wsSearchOpen,
    tableDialogOpen,
    symbolOpen,
    shortcutsOpen,
    versionsOpen,
    backlinksOpen,
    brokenOpen,
    diffOpen,
    commentsOpen,
    trackOpen,
    commentAddTarget,
    settingsOpen,
    store,
  ]);

  // 검색 바는 모달이 아니므로 기존 편집기 복귀를 유지한다. 모달은 공통
  // 포커스 관리자가 자신을 열었던 버튼·입력·편집 위치로 복귀시킨다.
  const hadSearch = useRef(false);
  useEffect(() => {
    if (hadSearch.current && !state.searchOpen && !modalOpen) focusEditor();
    hadSearch.current = state.searchOpen;
  }, [state.searchOpen, modalOpen, focusEditor]);

  // 위키링크 자동완성 목록 — 트리 기반(워크스페이스 문서들).
  useEffect(() => {
    const candidates = workspaceCompletions(state.tree);
    setWikiDocsProvider(() => candidates.docs);
    setTagListProvider(() => candidates.tags);
    return () => {
      setWikiDocsProvider(null);
      setTagListProvider(null);
    };
  }, [state.tree]);

  // 늦은 다른 폴더 응답은 적용하지 않으며 조회 오류를 빈 그래프로 숨기지 않는다.
  useEffect(() => {
    if (!graphOpen) return;
    let disposed = false;
    setDocumentLinks([]); setGraphError(null);
    const root = store.state.workspace;
    if (!root) { setGraphLoading(false); return; }
    const revision = state.linksRevision;
    const current = () => !disposed && store.state.workspace === root && store.state.linksRevision === revision;
    setGraphLoading(true);
    // Coalesce file-event bursts, and let an existing scan finish before starting
    // the latest request. Superseded queued requests never scan the workspace.
    const timer = setTimeout(() => {
      const previous = graphRequest.current;
      const request = (async () => {
        await previous;
        if (!current()) return;
        try {
          const edges = await api.documentEdges(root);
          if (current()) setDocumentLinks(edges);
        } catch (error) {
          if (current()) setGraphError(String(error));
        } finally { if (current()) setGraphLoading(false); }
      })();
      graphRequest.current = request;
      void request.then(() => { if (graphRequest.current === request) graphRequest.current = null; });
    }, 250);
    return () => { disposed = true; clearTimeout(timer); };
  }, [graphOpen, state.workspace, state.linksRevision, graphReload]);

  // — CSS 변수로 테마·글꼴 반영 —
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = state.theme;
    root.style.setProperty("--md-font-size", `${state.settings.fontSize}px`);
    // 줄 폭은 기준 글꼴(15px) 값 — 줌으로 글꼴이 커지면 페이지도 함께
    // 커진다(Word 줌). 문서별 글꼴이 있는 에디터는 docStyle이 실효 글꼴로
    // 다시 덮어쓴다.
    root.style.setProperty(
      "--md-line-width",
      scaledLineWidth(state.settings.lineWidth, state.settings.fontSize),
    );
    // 글꼴 크기가 바뀌면 줄 높이가 변해 CM 추정이 어긋난다 — 재측정.
    editorView.current?.requestMeasure();
  }, [state.theme, state.settings.fontSize, state.settings.lineWidth]);

  /** 드롭된 이미지들을 assets/ 로 복사해 커서에 참조 삽입(여러 장 연속). */
  const importDroppedImages = useCallback(
    (imgs: string[]) => store.importImages(editorView.current, imgs),
    [store],
  );

  // — 문서 열기에 성공하고 여전히 최신 탐색일 때만 결과 줄로 이동한다.
  const revealInPath = useCallback(
    (path: string, lineNo: number) => {
      void store.openPath(path, undefined, { line: lineNo });
    },
    [store],
  );

  // — 링크 클릭(에디터 장식) —
  useEffect(() => {
    setLinkClickHandler((url, baseDir) => {
      const target = resolveLink(url, baseDir);
      if (target.kind === "markdown") {
        void store.openPath(target.path, undefined,
          target.anchor === null ? undefined : { anchor: target.anchor });
      } else if (target.kind === "external" || target.kind === "mail") {
        void import("@tauri-apps/plugin-opener").then((opener) =>
          opener
            .openUrl(target.url)
            .catch(() => store.toast(phrases.linkOpenFailed, "error")),
        );
      } else if (target.kind === "anchor") {
        store.revealLocation({ anchor: target.id });
      }
    });
    return () => setLinkClickHandler(null);
  }, [store]);

  const activeTab = state.tabs.find((x) => x.id === state.activeId) ?? null;

  useEffect(() => {
    if (viewer && !viewer.current()) {
      setViewer(null);
      store.toast(t.imageViewerChanged, "info");
    }
  }, [viewer, state, store, t]);

  // 소스 미리보기 토글·모드 전환으로 에디터 폭이 변해도 CM 측정을 맞춘다
  // (깊은 스크롤 위치 점프 방지 — 글꼴 효과와 같은 규칙).
  useEffect(() => {
    editorView.current?.requestMeasure();
  }, [state.settings.sourcePreview, activeTab?.mode]);
  const conflictTab = state.tabs.find(
    (x) => x.conflict === "conflict" || x.conflict === "removed",
  );

  return (
    <div ref={appRoot} className={`app ${state.theme}`}>
      <div className="app-columns" ref={appColumns}>
        <Sidebar
          store={store}
          tree={state.tree}
          workspace={state.workspace}
          activePath={activeTab?.path ?? null}
          t={t}
          open={state.sidebarOpen}
          onModalChange={setSidebarModalOpen}
        />
        <main className="app-main">
          <TabBar
          store={store}
          t={t}
          onClose={(tab) => void closeTabWithConfirm(tab)}
          onCloseOthers={(tab) => closeTabsBatch(state.tabs.filter((x) => x.id !== tab.id))}
          onCloseRight={(tab) => {
            const idx = state.tabs.findIndex((x) => x.id === tab.id);
            closeTabsBatch(state.tabs.filter((_, i) => i > idx));
          }}
          onPin={(tab) => {
            const next = pinnedTabId === tab.id ? null : tab.id;
            store.pinnedTabId = next;
            setPinnedTabId(next);
          }}
          onLock={(tab) => store.setLocked(tab.id, !store.lockedTabIds.has(tab.id))}
        />
          <Toolbar store={store} t={t} onInsertTable={() => setTableDialogOpen(true)} />
          {state.settingsError && (
            <div className="settings-save-status" role="alert">
              <span>{t.settingsSaveFailed}: {state.settingsError}</span>
              <button className="btn" disabled={state.settingsSaving}
                onClick={() => void store.flushSettings().catch(() => {})}>
                {state.settingsSaving ? t.settingsSaving : t.wsRetry}
              </button>
            </div>
          )}
          <SearchPanel store={store} view={editorView.current} t={t} open={state.searchOpen} />
          <div className={`edit-split ${pinnedTabId ? "has-ref" : ""}`}>
          <div
            id="active-document-panel"
            role="tabpanel"
            aria-labelledby={activeTab ? documentTabId(activeTab.id) : undefined}
            className={`editor-area ${activeTab?.mode === "read" ? "read-mode" : ""} ${
              activeTab?.mode === "source" ? "source-mode" : ""
            } ${
              // 페이지 보기 — 줄 폭 고정(>0)인 편집 모드: 읽기 모드와 같은
              // 종이 카드 규칙(회색 여백·중앙 페이지). 0이면 전체 폭 캔버스.
              activeTab?.mode === "edit" && state.settings.lineWidth > 0 ? "page-view" : ""
            }`}
          >
            <MiniToolbar store={store} t={t} />
            <div className="source-split">
              <div className="editor-host" ref={editorHost} />
              {activeTab?.mode === "source" && state.settings.sourcePreview && (
                <SourcePreview store={store} tab={activeTab} t={t} />
              )}
            </div>
            {!state.ready && <div className="app-splash">{t.loading}</div>}
            {state.ready && state.tabs.length === 0 && (
              <Welcome
                store={store}
                t={t}
                lang={lang}
                onOpenTemplates={(initialId) => setTemplatePicker({ initialId })}
                onOpenFile={() => void pickOpenFile().then((p) => { if (p) void store.openPath(p); })}
                onOpenFolder={() => void pickOpenFolder().then((d) => { if (d) void store.openWorkspace(d); })}
              />
            )}
          </div>
          {pinnedTabId && state.tabs.some((x) => x.id === pinnedTabId) && (
            <RefPane store={store} t={t} tabId={pinnedTabId} onClose={() => setPinnedTabId(null)} />
          )}
          </div>
          <StatusBar store={store} t={t} onOpenSettings={() => setSettingsOpen(true)} onOpenStyle={() => setStyleOpen(true)} onOpenStats={() => setStatsOpen(true)} onOpenBacklinks={() => setBacklinksOpen(true)} onOpenComments={() => setCommentsOpen(true)} onOpenTrack={() => setTrackOpen(true)} />
        </main>
        <TocPanel store={store} t={t} open={state.tocOpen} />
      </div>

      {/* 오버레이 */}
      {state.busy && !exportRunning.current && (
        <div className="overlay" role="status" aria-live="polite">
          <div className="overlay-card">
            <div className="spinner" aria-hidden="true" />
            {state.busy}
          </div>
        </div>
      )}
      {closeAsk && <CloseConfirm store={store} t={t} targetIds={closeTargets} requestKey={closeAsk} onDone={(p) => closeAsk(p)}
        onDiscard={quitRound === null ? undefined : (ids) => {
          if (quitRoundRef.current === quitRound) {
            for (const id of ids) quitDiscardedIds.current.add(id);
          } else {
            store.restoreDiscardedDocuments(ids);
          }
        }}
      />}
      {quitWaiting && quitRound !== null && (
        <div className="overlay modal-overlay" role="dialog" aria-modal="true" aria-labelledby="quit-wait-title"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              void api.quitReply(quitRound, false).catch((e) => store.toast(String(e), "error"));
            }
          }}>
          <div className="modal">
            <p id="quit-wait-title" className="modal-text">{t.quitWaiting}</p>
            <div className="modal-actions">
              <button className="btn" autoFocus onClick={() => {
                void api.quitReply(quitRound, false).catch((e) => store.toast(String(e), "error"));
              }}>{t.cancel}</button>
            </div>
          </div>
        </div>
      )}
      {conflictTab && !sidebarModalOpen && !templatePicker && !state.exportKind && !printOpen && !closeAsk && quitRound === null && <ConflictDialog store={store} tab={conflictTab} t={t} />}
      {state.exportKind && (
        <ExportSheet
          key={state.exportKind}
          kind={state.exportKind}
          t={t}
          capture={() => {
            const tab = store.active;
            return tab ? captureExportSnapshot({ ...tab, state: store.view?.state ?? tab.state }, {
              workspace: store.state.workspace, theme: store.state.theme,
              pageNumbers: store.state.settings.exportPageNumbers, header: store.state.settings.exportHeader,
              wikiIndex: store.wikiIndex, lang,
            }, state.exportKind === "docx") : null;
          }}
          onReveal={isInApp() ? (path) => api.revealInFinder(path) : undefined}
          pageNumbers={state.settings.exportPageNumbers}
          onTogglePageNumbers={setExportPageNumbers}
          pdfHeader={state.settings.exportHeader}
          onTogglePdfHeader={setExportHeader}
          saved={{
            paper: state.settings.exportPaper,
            landscape: state.settings.exportLandscape,
            margin: state.settings.exportMarginMm,
            scale: state.settings.exportScale,
          }}
          onRun={runExport}
          onCancel={() => store.setExportKind(null)}
        />
      )}
      <SettingsSheet
        store={store}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        t={t}
      />
      {styleOpen && <StylePanel store={store} onClose={() => setStyleOpen(false)} t={t} />}
      {templatePicker && <TemplatePicker t={t} theme={state.theme} initialId={templatePicker.initialId}
        captureDocument={activeTab ? () => {
          const tab = store.active;
          if (!tab) return null;
          const doc = store.view?.state.doc ?? tab.state.doc;
          if (doc.length > 512 * 1024) throw { code: "tooLarge" };
          return { name: tab.title || t.untitled, content: doc.toString() };
        } : undefined}
        onCreate={(content) => store.newTabWithContent(content)} onClose={() => setTemplatePicker(null)} />}
      {paletteOpen && (
        <CommandPalette
          store={store}
          t={t}
          onCloseDocument={() => { const tab = store.active; if (tab) void closeTabWithConfirm(tab); }}
          onClose={() => setPaletteOpen(false)}
          onOpenRenameHeading={() => { setPaletteOpen(false); void openRenameHeadingFlow(); }}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenStats={() => setStatsOpen(true)}
          onOpenSymbols={() => setSymbolOpen(true)}
          onOpenTableDialog={() => setTableDialogOpen(true)}
          onOpenStyle={() => setStyleOpen(true)}
          onOpenPrint={() => setPrintOpen(true)}
          onOpenExport={(kind) => store.setExportKind(kind)}
          onOpenDiff={() => setDiffOpen(true)}
          onOpenGraph={() => setGraphOpen(true)}
          onOpenTemplates={(initialId) => {
            setPaletteOpen(false);
            setTemplatePicker({ initialId });
          }}
          onOpenWsSearch={() => setWsSearchOpen(true)}
          onOpenVersions={() => setVersionsOpen(true)}
          onOpenBacklinks={() => setBacklinksOpen(true)}
          onOpenBrokenLinks={() => setBrokenOpen(true)}
          onOpenComments={() => setCommentsOpen(true)}
          onOpenTrack={(action) => { setTrackAction(action); setTrackOpen(true); }}
          onOpenReview={() => setReviewOpen(true)}
          onOpenFrontMatter={() => setFmOpen(true)}
          onAddComment={() => {
            // 커서 줄에 메모 추가(우클릭 메뉴와 같은 대화상자).
            const v = editorView.current;
            const tab = store.active;
            if (!v || !tab?.path) { store.toast(t.commentSaveDocument, "error"); return; }
            setCommentAddTarget({ id: tab.id, path: tab.path, title: tab.title,
              lineNo: v.state.doc.lineAt(v.state.selection.main.head).number, doc: v.state.doc });
          }}
        />
      )}
      {graphOpen && (
        <GraphView
          store={store}
          t={t}
          links={documentLinks}
          loading={graphLoading}
          error={graphError}
          onRetry={() => setGraphReload((n) => n + 1)}
          onClose={() => setGraphOpen(false)}
          onOpen={(path) => {
            setGraphOpen(false);
            void store.openPath(path);
          }}
        />
      )}
      {wsSearchOpen && (
        <WorkspaceSearch
          store={store}
          t={t}
          onClose={() => setWsSearchOpen(false)}
          onOpenHit={revealInPath}
          initialQuery={wsSearchQuery}
        />
      )}
      {brokenOpen && (
        <BrokenLinksPanel
          store={store}
          t={t}
          onClose={() => setBrokenOpen(false)}
          onGoto={(from) => {
            const view = editorView.current;
            if (!view) return;
            view.dispatch({ selection: { anchor: Math.min(from, view.state.doc.length) } });
            smoothScrollIntoView(view, Math.min(from, view.state.doc.length));
          }}
        />
      )}
      {backlinksOpen && (
        <BacklinksPanel
          store={store}
          t={t}
          onClose={() => setBacklinksOpen(false)}
          onOpenHit={revealInPath}
        />
      )}
      {versionsOpen && (
        <VersionsPanel
          store={store}
          t={t}
          onClose={() => setVersionsOpen(false)}
          onRestored={() => {
            setVersionsOpen(false);
            store.toast(t.versionsRestored);
          }}
        />
      )}
      {shortcutsOpen && <ShortcutsPanel t={t} onClose={() => setShortcutsOpen(false)} />}
      {statsOpen && <StatsPanel store={store} t={t} onClose={() => setStatsOpen(false)} />}
      {commentsOpen && <CommentsPanel store={store} t={t} onClose={() => setCommentsOpen(false)} />}
      {commentAddTarget !== null && (
        <CommentDialog
          t={t}
          title={commentAddTarget.title}
          lineNo={commentAddTarget.lineNo}
          onCancel={() => setCommentAddTarget(null)}
          onConfirm={async (text) => {
            await store.addComment(commentAddTarget, commentAddTarget.lineNo, text, commentAddTarget.doc);
            setCommentAddTarget(null);
          }}
        />
      )}
      {headingRename !== null && (
        <RenameHeadingDialog
          initialTitle={headingRename.title}
          linkCount={headingRename.linkCount}
          t={t}
          onCancel={() => setHeadingRename(null)}
          onConfirm={async ({ title, updateLinks }) => {
            const session = headingRename;
            setHeadingRename(null);
            const view = store.view;
            if (!view || !session || session.to > view.state.doc.length) return;
            // ① 현재 문서 — 제목 줄 교체 뒤 링크 재조준(한 트랜잭션).
            const oldText = view.state.doc.toString();
            const newLine = rewrittenHeadingLine(oldText.slice(session.from, session.to), title);
            const step1 = oldText.slice(0, session.from) + newLine + oldText.slice(session.to);
            const insert = updateLinks
              ? retargetHeadingLinks(step1, session.stem, session.title, title) ?? step1
              : step1;
            view.dispatch({
              changes: { from: 0, to: view.state.doc.length, insert },
              userEvent: "input.renameHeading",
            });
            // ② 다른 파일의 링크 — 디스크에서 읽어 기대값 맞춰 갱신(상한 200).
            if (!updateLinks || !session.path) return;
            let updated = 0;
            const walkFiles = async (nodes: TreeNode[]): Promise<string[]> => {
              const out: string[] = [];
              for (const n of nodes) {
                if (n.kind === "dir") out.push(...await walkFiles(n.children ?? []));
                else out.push(n.path);
              }
              return out;
            };
            for (const p of await walkFiles(store.state.tree)) {
              if (p === session.path || updated >= 200) continue;
              let doc;
              try { doc = await api.readDocument(p); } catch { continue; }
              const next = retargetHeadingLinks(doc.text, session.stem, session.title, title);
              if (next === null) continue;
              try {
                await api.writeDocument(p, next, doc.meta,
                  { kind: "match", text: doc.text, meta: doc.meta });
                updated++;
              } catch { /* 경합 — 다음 실행에서 다시 */ }
            }
            if (updated > 0) void store.refreshTree();
            store.toast(t.f.renameHeadingLinks(updateLinks ? session.linkCount : 0));
          }}
        />
      )}
      {fmOpen && <FrontMatterDialog store={store} t={t} onClose={() => setFmOpen(false)} />}
      {trackOpen && <TrackPanel store={store} t={t} initialAction={trackAction} onClose={() => { setTrackOpen(false); setTrackAction(null); }} />}
      {imageEdit !== null && (
          <LinkDialog
            kind="image"
            initial={imageEdit.initial}
            t={t}
            onCancel={() => setImageEdit(null)}
            onConfirm={(next) => {
              if (!imageEdit.apply(next)) throw new Error(t.linkTargetChanged);
              setImageEdit(null);
              store.toast(t.imageEdited);
            }}
          />
      )}
      {reviewOpen && (
        <ReviewPanel
          store={store}
          t={t}
          onClose={() => setReviewOpen(false)}
          onOpenBrokenLinks={() => { setReviewOpen(false); setBrokenOpen(true); }}
          onOpenStats={() => { setReviewOpen(false); setStatsOpen(true); }}
          onOpenTrack={() => { setReviewOpen(false); setTrackOpen(true); }}
        />
      )}
      {tableDialogOpen && (
        <TableDialog store={store} t={t} onClose={() => setTableDialogOpen(false)} />
      )}
      {symbolOpen && (
        <SymbolPanel
          t={t}
          store={store}
          onClose={() => setSymbolOpen(false)}
        />
      )}
      {printOpen && (
        <PrintPreview
          store={store}
          t={t}
          onReveal={isInApp() ? (path) => api.revealInFinder(path) : undefined}
          saved={{
            paper: state.settings.exportPaper,
            landscape: state.settings.exportLandscape,
            margin: state.settings.exportMarginMm,
            scale: state.settings.exportScale,
          }}
          onExport={runExport}
          onCancel={() => setPrintOpen(false)}
        />
      )}
      <ContextMenu store={store} t={t} onModalChange={setContextModalOpen} />
      {diffOpen && <DiffPanel store={store} t={t} onClose={() => setDiffOpen(false)} />}
      {viewer && (
        <ImageViewer
          src={viewer.images[viewer.index].src}
          alt={viewer.images[viewer.index].alt}
          occurrence={viewer.images[viewer.index].from}
          t={t}
          onClose={() => setViewer(null)}
          index={viewer.index}
          total={viewer.images.length}
          onNav={(dir) => {
            if (!viewer.current()) {
              setViewer(null);
              store.toast(t.imageViewerChanged, "info");
              return;
            }
            setViewer((current) => current && ({ ...current,
              index: (current.index + dir + current.images.length) % current.images.length,
            }));
          }}
          onEditAlt={viewer.view.state.readOnly ? undefined : () => {
            if (!viewer.current()) {
              setViewer(null);
              store.toast(t.imageViewerChanged, "info");
              return;
            }
            const image = viewer.images[viewer.index];
            const target = captureInlineLinkEdit(viewer.view, image.from, image.to);
            if (!target) { store.toast(t.linkTargetChanged, "error"); return; }
            setImageEdit(target);
            setViewer(null);
          }}
        />
      )}
      {/* 라이브 영역 — 저장 확인·오류가 스크린 리더에 발표된다(에러는 즉시). */}
      <div className="toasts" aria-live="polite">
        {state.toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast ${toast.kind} ${toast.leaving ? "is-leaving" : ""}`}
            role={toast.kind === "error" ? "alert" : "status"}
            title={t.close}
            onClick={() => {
              // 문구를 선택해 복사하는 중이면 닫지 않는다.
              if ((window.getSelection()?.toString() ?? "") !== "") return;
              store.dismissToast(toast.id);
            }}
          >
            {toast.text}
          </div>
        ))}
      </div>
      {!isInApp() && state.ready && <div className="browser-note">{t.notInApp}</div>}
    </div>
  );
}

function zoomBy(store: AppStore, dir: 1 | -1): void {
  const next = Math.min(28, Math.max(9, Math.round(store.state.settings.fontSize + dir)));
  updateSettings(store, { fontSize: next });
}

function updateSettings(
  store: AppStore,
  patch: Parameters<typeof api.patchSettings>[0],
): void {
  store.persistSettings(patch);
}

function detectBrowserLang(): Lang {
  const tags =
    typeof navigator !== "undefined"
      ? (navigator.languages ?? [navigator.language])
      : ([] as string[]);
  for (const tag of tags) {
    const p = tag.split("-")[0]?.toLowerCase();
    if (p === "ko") return "ko";
    if (p === "en") return "en";
  }
  return "en";
}
