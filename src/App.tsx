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
  pickOpenFile,
  pickOpenFolder,
  pickSave,
  webviewWindowApi,
} from "./api";
import { AppStore, resolveTheme, type ExportKind, type Tab } from "./app/store";
import { replaceDoc, setLinkClickHandler, setViewListener, smoothScrollIntoView } from "./editor/cm";
import { phrases, setPhrases } from "./app/phrases";
import { invalidateLinkPreviews } from "./editor/linkPreview";
import { frontMatterLen, frontMatterMeta, stripFrontMatter } from "./editor/frontmatter";
import { EPUB_CSS, epubChapterInputs, splitEpubChapters } from "./export/epub";
import { relPath } from "./paths";
import { resolveWikiLink, wikiLinksToMarkdown } from "./editor/wiki";
import { collectHeadings, resolveLink } from "./links";
import { makeT, type Lang } from "./i18n";
import { TabBar } from "./components/TabBar";
import { Sidebar } from "./components/Sidebar";
import { TocPanel } from "./components/TocPanel";
import { SearchPanel } from "./components/SearchPanel";
import { StatusBar } from "./components/StatusBar";
import { CloseConfirm, ConflictDialog } from "./components/Modals";
import { ExportSheet } from "./components/ExportSheet";
import { Toolbar } from "./components/Toolbar";
import { MiniToolbar } from "./components/MiniToolbar";
import { ContextMenu } from "./components/ContextMenu";
import { setImageResizeHandler, setImageViewerHandler, setTableHeaderClickHandler, setFrontMatterEditHandler, setImageCaptionHandler } from "./editor/widgets";
import { setTableWidthsSaveHandler } from "./editor/livePreview";
import { setTagClickHandler } from "./editor/cm";
import { setWikiDocsProvider, setTagListProvider, type WikiDoc } from "./editor/wikiComplete";
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
import { findImageAt } from "./editor/livePreview";
import { LinkDialog } from "./components/LinkDialog";
import { ReviewPanel } from "./components/ReviewPanel";
import { Welcome } from "./components/Welcome";
import { CommandPalette } from "./components/CommandPalette";
import { VersionsPanel } from "./components/VersionsPanel";
import { BacklinksPanel } from "./components/BacklinksPanel";
import { BrokenLinksPanel } from "./components/BrokenLinksPanel";
import { WorkspaceSearch } from "./components/WorkspaceSearch";
import { ImageViewer } from "./components/ImageViewer";
import { DiffPanel } from "./components/DiffPanel";
import { GraphView } from "./components/GraphView";
import * as fmt from "./editor/format";

const ioAdapter = {
  readDocument: (path: string) => api.readDocument(path),
  writeDocument: (
    path: string,
    text: string,
    meta: { hadBom: boolean; crlf: boolean },
  ) => api.writeDocument(path, text, meta),
  scanWorkspace: (root: string) => api.scanWorkspace(root),
  saveSession: (session: Parameters<typeof api.saveSession>[0]) => api.saveSession(session),
  setAssetScope: (path: string, recursive: boolean) => api.setAssetScope(path, recursive),
  watchPaths: (files: string[], dirs: string[]) => api.watchPaths(files, dirs),
  bookmarkList: (path: string) => api.bookmarkList(path),
  bookmarkAdd: (path: string, lineNo: number) => api.bookmarkAdd(path, lineNo),
  bookmarkRemove: (path: string, lineNo: number) => api.bookmarkRemove(path, lineNo),
  setSettings: (settings: Parameters<typeof api.setSettings>[0]) => api.setSettings(settings),
  backlinks: (root: string, path: string) => api.backlinks(root, path),
  commentList: (path: string) => api.commentList(path),
  commentAdd: (path: string, lineNo: number, text: string) => api.commentAdd(path, lineNo, text),
  commentUpdate: (id: number, text: string) => api.commentUpdate(id, text),
  commentResolve: (id: number, resolved: boolean) => api.commentResolve(id, resolved),
  commentRemove: (id: number) => api.commentRemove(id),
  baselineGet: (path: string) => api.baselineGet(path),
  baselineSet: (path: string, text: string) => api.baselineSet(path, text),
  baselineClear: (path: string) => api.baselineClear(path),
  speakStart: (text: string, rate: number, voice: string) => api.speakStart(text, rate, voice),
  speakStop: () => api.speakStop(),
  speakStatus: () => api.speakStatus(),
};

export interface PdfExportOptions {
  paper: "a4" | "letter" | "a5";
  orientation: "portrait" | "landscape";
  marginMm: number;
  scale: number;
}

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
  const editorView = useRef<EditorView | null>(null);
  /** 닫기 확인 진행 중인 콜백(창 닫기·탭 닫기 공용). */
  const [closeAsk, setCloseAsk] = useState<((proceed: boolean) => void) | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [wsSearchOpen, setWsSearchOpen] = useState(false);
  const [wsSearchQuery, setWsSearchQuery] = useState("");
  const [graphOpen, setGraphOpen] = useState(false);
  const [wikiLinks, setWikiLinks] = useState<Array<{ from: string; to: string }>>([]);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  const [brokenOpen, setBrokenOpen] = useState(false);
  const [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerTotal, setViewerTotal] = useState(0);
  const [diffOpen, setDiffOpen] = useState(false);
  // 내보내기 토글·옵션은 설정에 산다 — 재시작에도 유지(Word 인쇄 설정 기억).
  const setExportPageNumbers = (v: boolean) => updateSettings(store, { exportPageNumbers: v });
  const setExportHeader = (v: boolean) => updateSettings(store, { exportHeader: v });
  const [symbolOpen, setSymbolOpen] = useState(false);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  /** 메모 추가 대화상자 줄(팔레트). */
  const [commentAddLine, setCommentAddLine] = useState<number | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [fmOpen, setFmOpen] = useState(false);
  /** 이미지 설명 편집(칩 클릭 위치 → 그 이미지). */
  const [imgEditPos, setImgEditPos] = useState<number | null>(null);
  /** 참조 보기 — 옆에 고정한 탭(읽기 전용 iframe 렌더). */
  const [pinnedTabId, setPinnedTabId] = useState<string | null>(null);
  const [trackOpen, setTrackOpen] = useState(false);
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
  const modalOpen = !!(
    closeAsk ||
    settingsOpen ||
    styleOpen ||
    printOpen ||
    shortcutsOpen ||
    statsOpen ||
    paletteOpen ||
    wsSearchOpen ||
    versionsOpen ||
    backlinksOpen ||
    brokenOpen ||
    diffOpen ||
    state.exportKind ||
    state.busy ||
    state.tabs.some((x) => x.conflict === "conflict" || x.conflict === "removed")
  );
  useEffect(() => {
    if (editorHost.current) editorHost.current.inert = modalOpen;
  }, [modalOpen]);

  // 모달 포커스 트랩 — Tab이 배경 UI로 새는 것을 막고 오버레이 안에서 순환.
  useEffect(() => {
    if (!modalOpen) return;
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      // 가장 나중에 뜬 오버레이(현재 대화상자) 안의 포커스 가능 요소들.
      const overlays = Array.from(document.querySelectorAll<HTMLElement>(".overlay"));
      const top = overlays.filter((o) => o.offsetParent !== null).pop();
      if (!top) return;
      const focusables = Array.from(
        top.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!top.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onTab, true);
    return () => window.removeEventListener("keydown", onTab, true);
  }, [modalOpen]);

  // — 초기화 —
  useEffect(() => {
    store.phrases = { bigDocSource: t.bigDocSource };
    setPhrases({
      mathError: t.mathError,
      diagramError: t.diagramError,
      imgMissing: t.imgMissing,
      imgLoadBlocked: t.imgLoadBlocked,
      linkOpen: t.linkOpen,
      linkOpenFailed: t.linkOpenFailed,
      saveFailed: t.saveFailed,
      speakStartedDoc: t.speakStartedDoc,
      speakStartedSel: t.speakStartedSel,
      speakFailed: t.speakFailed,
    });
    let disposed = false;
    initBridge();
    // 앱 셸 첫 페인트가 나왔다 — index.html의 부트 스플래시를 치운다.
    document.getElementById("iyagi-boot")?.remove();
    store.state.ready = false;
    (async () => {
      try {
        const settings = await api.getSettings();
        store.setSettings(settings);
      } catch {
        /* 브라우저 개발 — 기본값 */
      }
      // 보조 창(doc-*)은 세션을 복원하지 않고 지정 파일만 — main이 세션을 소유.
      const isAux = windowLabel() !== "main";
      const file = fileParam();
      if (isAux && file) {
        await store.openPath(file);
      } else {
        try {
          const session = await api.getSession();
          if (session && !disposed) await store.restoreSession(session);
        } catch {
          /* 무시 */
        }
      }
      try {
        const pending = await api.takePendingFiles();
        for (const p of pending) await store.openPath(p);
      } catch {
        /* 무시 */
      }
      if (store.state.tabs.length === 0) store.newTab();
      // 참조 보기 복원 — 경로로 탭 id 해소.
      if (store.pendingPinnedPath) {
        const t = store.state.tabs.find((x) => x.path === store.pendingPinnedPath);
        if (t) store.pinnedTabId = t.id;
        store.pendingPinnedPath = null;
      }
      // 잠금 복원 — 경로로 탭에 적용.
      for (const lp of store.pendingLockedPaths) {
        const t = store.state.tabs.find((x) => x.path === lp);
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
    setImageResizeHandler((src, pct) => store.setImageWidth(src, pct));
    setImageViewerHandler((src, alt) => {
      const doc = store.view?.state.doc.toString() ?? "";
      const all = [...doc.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map((m) => m[1]);
      setViewerIndex(Math.max(0, all.indexOf(src)));
      setViewerTotal(all.length);
      setViewer({ src, alt });
    });
    setFrontMatterEditHandler(() => setFmOpen(true));
    // 이미지 '설명 추가' 칩 — 그 이미지의 대체 텍스트 편집(69차 대화상자 재사용).
    setImageCaptionHandler((_src, pos) => setImgEditPos(pos));
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
  }, [store]);

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
    const tab = store.active;
    if (tab) view.setState(tab.state);
    store.applyConfig();
    return () => {
      setViewListener(null);
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
    const ok = await store.saveActive(path);
    if (ok) store.toast(t.savedToast);
    return ok;
  }, [store, t]);

  const saveActive = useCallback(async () => {
    const tab = store.active;
    if (!tab) return;
    if (tab.path && !tab.dirty) return; // 무수정 저장 안 함(§4-2)
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

  /** 문서의 첫 로컬 이미지 경로(절대) — http(s)/데이터 URL 제외. */
  const firstLocalImage = (md: string, baseDir: string): string | null => {
    for (const m of md.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      const src = m[1];
      if (/^(https?:|data:)/i.test(src)) continue;
      if (src.startsWith("/")) return src;
      return baseDir ? `${baseDir}/${src.replace(/\.\//g, "")}` : src;
    }
    return null;
  };

  const runExport = useCallback(
    async (kind: ExportKind, opts: PdfExportOptions) => {
      const tab = store.active;
      if (!tab) return;
      // 내보내기 본문은 메타가 아니다 — 프론트매터는 제외하고 내보낸다.
      // 위키링크는 표준 마크다운 링크로(DOCX는 텍스트가 그대로 Rust로 간다).
      const baseDir0 = tab.path
        ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/"
        : store.state.workspace ?? "";
      const wikiResolve = (name: string) => resolveWikiLink(name, baseDir0, store.wikiIndex);
      const text = wikiLinksToMarkdown(
        stripFrontMatter(tab.state.doc.toString()),
        wikiResolve,
        baseDir0,
      );
      // 프런트매터 메타 — 문서가 스스로 밝히는 제목·작가가 내보내기 식별자가 된다.
      const fm = frontMatterMeta(tab.state.doc.toString());
      const metaTitle = fm?.title ?? "";
      const metaAuthor = fm?.author ?? "";
      const name = (metaTitle || (tab.path ? tab.title : "untitled"))
        .replace(/\.(md|markdown)$/i, "")
        .replace(/[\/:*?"<>|]/g, "-"); // 파일명에 못 쓰는 글자
      const docTitle = metaTitle || (tab.path ? tab.title : name);
      const ext = kind === "html" ? "html" : kind === "pdf" ? "pdf" : kind === "epub" ? "epub" : "docx";
      const out = await pickSave(`${name}.${ext}`, ext);
      if (!out) return;
      store.setBusy(t.exportPreparing);
      try {
        // markdown-it(±footnote)은 내보내기에서만 쓴다 — 동적 로드로 메인
        // 청크에서 빼 시작 로딩을 줄인다.
        const { buildDocxManifest, buildExportHtml, renderMarkdownBody } = await import("./export/html");

        const baseDir = tab.path
          ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/"
          : store.state.workspace ?? "";
        // 사이드카 이미지 폭(%) — 편집기 드래그 값과 동일하게 4경로 모두 반영.
        const imageWidths = tab.docStyle?.imageWidths ?? {};
        const tableWidths = tab.docStyle?.tableWidths ?? {};
        if (kind === "html") {
          const html = await buildExportHtml(text, {
            title: docTitle,
            baseDir,
            theme: store.state.theme,
            style: exportStyleOf(tab),
            imageWidths,
            tableWidths,
            frontLists: { toc: !!fm?.toc, lof: !!fm?.lof, lot: !!fm?.lot },
            lang,
            externalLinksNewTab: true,
            readBytes: readBytesForExport,
            wikiResolve,
          });
          await api.writeExportFile(out, html);
        } else if (kind === "pdf") {
          const html = await buildExportHtml(text, {
            title: docTitle,
            baseDir,
            theme: store.state.theme,
            forPdf: true,
            marginMm: opts.marginMm,
            scale: opts.scale,
            style: exportStyleOf(tab),
            imageWidths,
            tableWidths,
            // 머리글 — 프런트매터 header: 가 있으면 문서가 정한 대로(설정 무시).
            pdfHeader: fm?.header ?? (state.settings.exportHeader ? docTitle : null),
            pdfFooter: fm?.footer ?? null,
            readBytes: readBytesForExport,
            wikiResolve,
          });
          await api.exportPdf(html, { ...opts, pageNumbers: state.settings.exportPageNumbers }, out);
        } else if (kind === "epub") {
          // EPUB — 본문 조각을 XHTML로(빈 태그 자가 폐쇄) + 최소 가독 CSS.
          // 이미지는 data URI로 인라인하지 않는다 — 로컬 경로를 그대로 두면
          // Rust가 디스크에서 읽어 zip 안 images/ 로 임베드한다(DOCX와 동일).
          const { body } = await renderMarkdownBody(text, {
            title: docTitle,
            baseDir,
            theme: store.state.theme,
          });
          const { applyImageWidths, applyTableWidths, applyFigcaptions } = await import("./export/html");
          const { applyTableCaptions } = await import("./editor/tableCaption");
          // 전체를 한 번 렌더한 HTML을 <h1> 경계로 챕터 분할(각주는 마지막 챕터에).
          // 캡션(그림·표)도 HTML/PDF와 동일하게 — 빠지면 전자책만 설명 없음.
          const decorated = applyFigcaptions(
            applyTableCaptions(applyTableWidths(applyImageWidths(body, imageWidths), tableWidths)),
          );
          const chapters = epubChapterInputs(splitEpubChapters(decorated));
          // 표지 — 문서의 첫 로컬 이미지. 프런트매터 cover: false면 끔.
          const coverPath = fm?.cover === false ? null : firstLocalImage(text, baseDir);
          await api.exportEpub(
            {
              chapters,
              title: docTitle,
              author: metaAuthor || "IYAGI Markdown",
              language: lang === "ko" ? "ko" : "en",
              css: EPUB_CSS,
              coverPath,
              baseDir,
            },
            out,
          );
        } else {
          const manifest = await buildDocxManifest(text);
          // 문서별 스타일 → DOCX 기본 서체(폰트·크기).
          const ds = tab.docStyle;
          manifest.style = {
            font: ds?.font ?? "system",
            sizePt: ds && ds.fontSize > 0 ? ds.fontSize : 11,
            lineHeight: ds?.lineHeight ?? 0,
            firstLineIndent: ds?.firstLineIndent ?? false,
            textAlign: ds?.textAlign ?? "left",
            accent: ds?.accent ?? null,
            pageNumbers: state.settings.exportPageNumbers,
          };
          manifest.imageWidths = imageWidths;
          manifest.tableWidths = tableWidths;
          // 문서 메모 — 편집기 줄 번호를 프런트매터 제거 본문 기준으로 보정.
          if (tab.comments && tab.comments.length > 0) {
            const fmLen = frontMatterLen(tab.state.doc.toString());
            const fmLines = fmLen > 0 ? tab.state.doc.sliceString(0, fmLen).split("\n").length - 1 : 0;
            manifest.comments = tab.comments
              .filter((c) => !c.resolved)
              .map((c) => [c.lineNo - fmLines, c.text] as [number, string])
              .filter(([l]) => l > 0);
          }
          if (metaTitle) manifest.title = metaTitle;
          if (metaAuthor) manifest.author = metaAuthor;
          manifest.frontLang = lang;
          if (fm?.columns && fm.columns > 1) manifest.columns = fm.columns;
          if (fm?.toc) manifest.toc = true;
          if (fm?.lof) manifest.lof = true;
          if (fm?.lot) manifest.lot = true;
          if (fm?.header) manifest.headerTitle = fm.header;
          else if (state.settings.exportHeader) manifest.headerTitle = docTitle;
          if (fm?.footer) manifest.footerText = fm.footer;
          await api.exportDocx(text, manifest, out, baseDir);
        }
        // 마지막 옵션 저장(재시작 유지) — PDF 옵션은 pdf에만 있고 docx는 토글만.
        if (kind === "pdf" || kind === "epub") {
          updateSettings(store, {
            exportPaper: opts.paper,
            exportLandscape: opts.orientation === "landscape",
            exportMarginMm: opts.marginMm,
            exportScale: opts.scale,
          });
        }
        store.setBusy(null);
        store.toast(t.f.exportDone(`${name}.${ext}`));
      } catch (e) {
        store.setBusy(null);
        store.toast(`${t.exportFailed}: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
    [store, t, readBytesForExport],
  );

  // — 탭 닫기(더티 확인 동반) —
  const closeTabWithConfirm = useCallback(
    async (tab: Tab) => {
      if (tab.dirty) {
        const ok = await new Promise<boolean>((resolve) => setCloseAsk(() => resolve));
        setCloseAsk(null);
        if (!ok) return;
      }
      store.closeTab(tab.id);
    },
    [store],
  );

  /** 여러 탭 한 번에 닫기 — 더티가 하나라도 있으면 확인은 한 번만. */
  const closeTabsBatch = useCallback(
    (tabs: Tab[]) => {
      if (tabs.length === 0) return;
      if (tabs.some((x) => x.dirty)) {
        setCloseAsk(() => (ok: boolean) => {
          setCloseAsk(null);
          if (ok) for (const x of tabs) store.closeTab(x.id);
        });
        return;
      }
      for (const x of tabs) store.closeTab(x.id);
    },
    [store],
  );

  // — 메뉴/단축키 동작 —
  const handleMenu = useCallback(
    (id: string) => {
      if (windowLabel() !== "main") return; // 보조 창은 메인이 메뉴를 소유
      if (id.startsWith("recent:")) {
        void store.openPath(id.slice("recent:".length));
        return;
      }
      switch (id) {
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
          void api.clearRecent().catch(() => {});
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
        case "close-tab": {
          const tab = store.active;
          if (tab) void closeTabWithConfirm(tab);
          break;
        }
        case "find":
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

  // — 이벤트 구독 —
  useEffect(() => {
    const unlistens: (() => void)[] = [];
    let disposed = false;
    const keep = (p: Promise<{ (): void } | void | undefined>) => {
      void p.then((u) => {
        if (u && !disposed) unlistens.push(u as () => void);
      });
    };

    keep(onMenu((id) => handleMenu(id)));
    keep(
      onFsEvent((e) => {
        store.externalChange(e.path, e.kind);
        invalidateLinkPreviews(e.path); // 호버 미리보기 캐시도 함께 무효화
      }),
    );
    keep(onOpenFiles(async (paths) => {
      for (const p of paths) await store.openPath(p);
    }));
    keep(onSettingsChanged((s) => store.setSettings(s)));

    // 시스템 테마 추종(auto일 때).
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onTheme = () => {
      if (store.state.settings.theme === "auto") store.setTheme(resolveTheme(store.state.settings));
    };
    mq.addEventListener("change", onTheme);

    // 브라우저 폴백 단축키(macOS 메뉴 가속기가 없는 환경).
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === "e") {
        e.preventDefault();
        store.toggleReadEdit();
      } else if (key === "/") {
        e.preventDefault();
        store.setMode(store.active?.mode === "source" ? "edit" : "source");
      } else if (key === "f") {
        e.preventDefault();
        if (e.shiftKey) setWsSearchOpen(true);
        else store.setSearchOpen(true);
      } else if (key === "s") {
        e.preventDefault();
        if (e.shiftKey) void saveAs();
        else void saveActive();
      } else if (key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (key === "p" && e.shiftKey) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);

    // 파일 드래그 앤 드롭(Tauri 경로 이벤트).
    if (isInApp()) {
      void import("@tauri-apps/api/event").then(async (ev) => {
        const u = await ev.listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
          const paths = e.payload.paths;
          for (const p of paths.filter((x) => /\.(md|markdown)$/i.test(x))) {
            void store.openPath(p);
          }
          // 이미지 드롭 — 문서 폴더 assets/ 로 복사해 커서에 삽입(Typora 방식).
          const imgs = paths.filter((x) => /\.(png|jpe?g|gif|webp|svg|bmp|heic)$/i.test(x));
          if (imgs.length > 0) void importDroppedImages(imgs);
        });
        if (!disposed) unlistens.push(u);
      });
      // 창 닫기 요청 — 더티 확인 후 세션 저장하고 닫는다(보조 창은 저장 없이).
      void webviewWindowApi().then(async (win) => {
        const u = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          const dirty = store.state.tabs.filter((x) => x.dirty);
          if (dirty.length > 0) {
            const ok = await new Promise<boolean>((resolve) => setCloseAsk(() => resolve));
            setCloseAsk(null);
            if (!ok) return;
          }
          if (windowLabel() === "main") {
            await api.saveSession(store.buildSession()).catch(() => {});
          } else {
            // 보조 창: 자기 위치를 세션에 남기고 닫힌다(저장은 메인이 소유).
            try {
              const pos = await win.outerPosition();
              const size = await win.innerSize();
              const scale = await win.scaleFactor();
              store.setAuxWindowRect({
                x: pos.x / scale,
                y: pos.y / scale,
                width: size.width / scale,
                height: size.height / scale,
              });
              await api.saveSession(store.buildSession()).catch(() => {});
            } catch {
              /* 위치 기록 실패는 닫기에 영향 없음 */
            }
          }
          await win.destroy();
        });
        if (!disposed) unlistens.push(u);
      });
    }

    return () => {
      disposed = true;
      for (const u of unlistens) u();
      mq.removeEventListener("change", onTheme);
      window.removeEventListener("keydown", onKey);
    };
  }, [store, handleMenu, saveActive, saveAs]);

  // — Esc로 시트 닫기(macOS 앱 관례) — 확인 대화상자가 떠 있으면 비켜주고,
  // 에디터가 먼저 처리한 Esc(자동완성 닫기 등)는 존중한다.
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (closeAsk) return;
      if (state.exportKind) {
        store.setExportKind(null);
        return;
      }
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
      if (fmOpen) {
        setFmOpen(false);
        return;
      }
      if (reviewOpen) {
        setReviewOpen(false);
        return;
      }
      if (settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [closeAsk, state.exportKind, styleOpen, printOpen, graphOpen, fmOpen, reviewOpen, settingsOpen, store]);

  // 위키링크 자동완성 목록 — 트리 기반(워크스페이스 문서들).
  useEffect(() => {
    setWikiDocsProvider(() => wikiDocsOf(state.tree));
    setTagListProvider(() => collectWorkspaceTags(state.tree));
    return () => {
      setWikiDocsProvider(null);
      setTagListProvider(null);
    };
  }, [state.tree]);

  // 그래프 뷰 — 위키링크 간선 로드(Rust wiki_edges).
  useEffect(() => {
    if (!graphOpen || !store.state.workspace) return;
    void api
      .wikiEdges(store.state.workspace)
      .then((edges) => setWikiLinks(edges))
      .catch(() => setWikiLinks([]));
  }, [graphOpen, store.state.workspace]);

  // — CSS 변수로 테마·글꼴 반영 —
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = state.theme;
    root.style.setProperty("--md-font-size", `${state.settings.fontSize}px`);
    root.style.setProperty(
      "--md-line-width",
      state.settings.lineWidth > 0 ? `${state.settings.lineWidth}px` : "100%",
    );
    // 글꼴 크기가 바뀌면 줄 높이가 변해 CM 추정이 어긋난다 — 재측정.
    editorView.current?.requestMeasure();
  }, [state.theme, state.settings.fontSize, state.settings.lineWidth]);

  // — 앵커 스크롤(링크 클릭) —
  const scrollToAnchor = useCallback(
    (id: string) => {
      const view = editorView.current;
      if (!view) return;
      const text = view.state.doc.toString();
      const target = collectHeadings(text).find((h) => h.slug === id || h.slug.startsWith(id));
      if (target) {
        const line = Math.min(
          view.state.doc.lineAt(target.pos).number,
          view.state.doc.lines,
        );
        smoothScrollIntoView(view, view.state.doc.line(line).from);
      }
    },
    [],
  );

  /** 드롭된 이미지들을 assets/ 로 복사해 커서에 참조 삽입(여러 장 연속). */
  const importDroppedImages = useCallback(
    async (imgs: string[]) => {
      const tab = store.active;
      const dir = tab?.path ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/" : store.state.workspace;
      if (!tab || !dir) {
        store.toast(t.imgDropNoDoc, "error");
        return;
      }
      for (const src of imgs) {
        try {
          const abs = await api.importImage(src, dir);
          const rel = relPath(dir, abs);
          const view = editorView.current;
          if (!view) return;
          const sel = view.state.selection.main;
          view.dispatch({
            changes: { from: sel.from, to: sel.to, insert: `![](${rel})\n` },
            selection: { anchor: sel.from + 4 },
            userEvent: "input.dropImage",
          });
        } catch (e) {
          store.toast(e instanceof Error ? e.message : String(e), "error");
        }
      }
    },
    [store, t],
  );

  // — 전체 검색 결과 열기: 문서를 열고(활성 탭이면 전환만) 커서를 해당 줄에.
  //    activate()가 뷰 상태를 동기로 갈아끼우므로 then 안에서 즉시 스크롤해도 된다.
  const revealInPath = useCallback(
    (path: string, lineNo: number) => {
      void store.openPath(path).then(() => {
        const view = editorView.current;
        if (!view) return;
        const line = view.state.doc.line(Math.min(Math.max(lineNo, 1), view.state.doc.lines));
        view.dispatch({ selection: { anchor: line.from } });
        smoothScrollIntoView(view, line.from);
      });
    },
    [store],
  );

  // — 링크 클릭(에디터 장식) —
  useEffect(() => {
    setLinkClickHandler((url, baseDir) => {
      const target = resolveLink(url, baseDir);
      if (target.kind === "markdown") {
        void store.openPath(target.path);
      } else if (target.kind === "external" || target.kind === "mail") {
        void import("@tauri-apps/plugin-opener").then((opener) =>
          opener
            .openUrl(target.kind === "mail" ? target.url : target.url)
            .catch(() => store.toast(phrases.linkOpenFailed, "error")),
        );
      } else if (target.kind === "anchor") {
        scrollToAnchor(target.id);
      }
    });
    return () => setLinkClickHandler(null);
  }, [store, scrollToAnchor]);

  const activeTab = state.tabs.find((x) => x.id === state.activeId) ?? null;

  // 소스 미리보기 토글·모드 전환으로 에디터 폭이 변해도 CM 측정을 맞춘다
  // (깊은 스크롤 위치 점프 방지 — 글꼴 효과와 같은 규칙).
  useEffect(() => {
    editorView.current?.requestMeasure();
  }, [state.settings.sourcePreview, activeTab?.mode]);
  const conflictTab = state.tabs.find(
    (x) => x.conflict === "conflict" || x.conflict === "removed",
  );

  return (
    <div className={`app ${state.theme}`}>
      <div className="app-columns">
        <Sidebar
          store={store}
          tree={state.tree}
          workspace={state.workspace}
          activePath={activeTab?.path ?? null}
          t={t}
          open={state.sidebarOpen}
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
          <SearchPanel store={store} view={editorView.current} t={t} open={state.searchOpen} />
          <div className={`edit-split ${pinnedTabId ? "has-ref" : ""}`}>
          <div
            className={`editor-area ${activeTab?.mode === "read" ? "read-mode" : ""} ${
              activeTab?.mode === "source" ? "source-mode" : ""
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
      {state.busy && (
        <div className="overlay" role="status" aria-live="polite">
          <div className="overlay-card">
            <div className="spinner" aria-hidden="true" />
            {state.busy}
          </div>
        </div>
      )}
      {closeAsk && <CloseConfirm store={store} t={t} onDone={(p) => closeAsk(p)} />}
      {conflictTab && !closeAsk && <ConflictDialog store={store} tab={conflictTab} t={t} />}
      {state.exportKind && (
        <ExportSheet
          kind={state.exportKind}
          t={t}
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
          onRun={(kind, opts) => {
            store.setExportKind(null);
            void runExport(kind, opts);
          }}
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
      {paletteOpen && (
        <CommandPalette
          store={store}
          t={t}
          onClose={() => setPaletteOpen(false)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenStats={() => setStatsOpen(true)}
          onOpenSymbols={() => setSymbolOpen(true)}
          onOpenTableDialog={() => setTableDialogOpen(true)}
          onOpenStyle={() => setStyleOpen(true)}
          onOpenPrint={() => setPrintOpen(true)}
          onOpenExport={(kind) => store.setExportKind(kind)}
          onOpenDiff={() => setDiffOpen(true)}
          onOpenGraph={() => setGraphOpen(true)}
          onNewFromTemplate={(content) => {
            store.setExportKind(null);
            store.newTabWithContent(content);
          }}
          onOpenWsSearch={() => setWsSearchOpen(true)}
          onOpenVersions={() => setVersionsOpen(true)}
          onOpenBacklinks={() => setBacklinksOpen(true)}
          onOpenBrokenLinks={() => setBrokenOpen(true)}
        />
      )}
      {graphOpen && (
        <GraphView
          store={store}
          t={t}
          wikiLinks={wikiLinks}
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
          onCreate={(name) => {
            const root = store.state.workspace;
            if (!root) return;
            setBrokenOpen(false); // 생성 후 패널 닫기 — 목록이 스테일해진다
            void store.createNote(`${root}/${name}.md`).then((ok) => {
              if (ok) store.toast(t.brokenCreated);
            });
          }}
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
          onRestore={(text) => {
            setVersionsOpen(false);
            const view = editorView.current;
            if (!view || !store.active) return;
            replaceDoc(view, text);
            view.dispatch({ selection: { anchor: 0 } });
            store.toast(t.versionsRestored);
          }}
        />
      )}
      {shortcutsOpen && <ShortcutsPanel t={t} onClose={() => setShortcutsOpen(false)} />}
      {statsOpen && <StatsPanel store={store} t={t} onClose={() => setStatsOpen(false)} />}
      {commentsOpen && <CommentsPanel store={store} t={t} onClose={() => setCommentsOpen(false)} />}
      {commentAddLine !== null && (
        <CommentDialog
          t={t}
          lineNo={commentAddLine}
          onCancel={() => setCommentAddLine(null)}
          onConfirm={(text) => {
            const line = commentAddLine;
            setCommentAddLine(null);
            void store.addComment(line, text);
          }}
        />
      )}
      {fmOpen && <FrontMatterDialog store={store} t={t} onClose={() => setFmOpen(false)} />}
      {trackOpen && <TrackPanel store={store} t={t} onClose={() => setTrackOpen(false)} />}
      {imgEditPos !== null && (() => {
        const view = editorView.current;
        const img = view ? findImageAt(view.state, imgEditPos) : null;
        if (!img) return null;
        return (
          <LinkDialog
            kind="image"
            initial={{ text: img.alt, url: img.url, from: img.from, to: img.to }}
            t={t}
            onCancel={() => setImgEditPos(null)}
            onConfirm={(next) => {
              const v = editorView.current;
              setImgEditPos(null);
              if (!v) return;
              v.dispatch({
                changes: { from: img.from, to: img.to, insert: `![${next.text}](${next.url})` },
                selection: { anchor: img.from + next.text.length + 4 },
                userEvent: "input.editImage",
              });
              v.focus();
              store.toast(t.imageEdited);
            }}
          />
        );
      })()}
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
          onClose={() => setSymbolOpen(false)}
          onInsert={(ch) => {
            const view = editorView.current;
            if (!view) return;
            const sel = view.state.selection.main;
            view.dispatch({
              changes: { from: sel.from, to: sel.to, insert: ch },
              selection: { anchor: sel.from + ch.length },
              userEvent: "input.type",
            });
            view.focus(); // 연속 삽입 — 패널은 유지(Word 기호 워크플로)
          }}
        />
      )}
      {printOpen && (
        <PrintPreview
          store={store}
          t={t}
          saved={{
            paper: state.settings.exportPaper,
            margin: state.settings.exportMarginMm,
            scale: state.settings.exportScale,
          }}
          onExport={(kind, opts) => {
            setPrintOpen(false);
            void runExport(kind, opts);
          }}
          onCancel={() => setPrintOpen(false)}
        />
      )}
      <ContextMenu store={store} t={t} />
      {diffOpen && <DiffPanel store={store} t={t} onClose={() => setDiffOpen(false)} />}
      {viewer && (
        <ImageViewer
          src={viewer.src}
          alt={viewer.alt}
          t={t}
          onClose={() => setViewer(null)}
          index={viewerIndex}
          total={viewerTotal}
          onNav={(dir) => {
            // 문서의 ![..](src) 위치 목록 — 현재 src 위치에서 이전/다음(순환).
            const v = editorView.current;
            if (!v) return;
            const doc = v.state.doc.toString();
            const positions: Array<{ src: string; at: number }> = [];
            for (const m of doc.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
              positions.push({ src: m[1]!, at: m.index ?? 0 });
            }
            if (positions.length === 0) return;
            const cur = positions.findIndex((p) => p.src === viewer.src);
            const next = positions[(cur + dir + positions.length) % positions.length] ?? positions[0]!;
            setViewer({ src: next.src, alt: "" });
            setViewerIndex(positions.indexOf(next));
            setViewerTotal(positions.length);
          }}
          onEditAlt={() => {
            // 문서에서 이 src의 첫 등장 위치를 찾아 편집 대화상자로.
            const v = editorView.current;
            if (!v) return;
            const doc = v.state.doc.toString();
            const needle = `](${viewer.src}`;
            const at = doc.indexOf(needle);
            if (at >= 0) {
              setViewer(null);
              setImgEditPos(at);
            }
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

/** 탭의 문서 스타일 → 내보내기 옵션(라이브 프리뷰와 동일 값). */
function exportStyleOf(tab: {
  docStyle: {
    font: "system" | "serif" | "round" | "mono";
    fontSize: number;
    lineHeight: number;
    firstLineIndent: boolean;
    textAlign: "left" | "center" | "right" | "justify";
    accent: string | null;
    highlightColor: string | null;
  } | null;
}): {
  font: "system" | "serif" | "round" | "mono";
  sizePt: number;
  lineHeight: number;
  firstLineIndent: boolean;
  textAlign: "left" | "center" | "right" | "justify";
  accent: string | null;
  highlightColor: string | null;
} {
  const ds = tab.docStyle;
  return {
    font: ds?.font ?? "system",
    sizePt: ds && ds.fontSize > 0 ? ds.fontSize : 11,
    lineHeight: ds?.lineHeight ?? 0,
    firstLineIndent: ds?.firstLineIndent ?? false,
    textAlign: ds?.textAlign ?? "left",
    accent: ds?.accent ?? null,
    highlightColor: ds?.highlightColor ?? null,
  };
}

function zoomBy(store: AppStore, dir: 1 | -1): void {
  const next = Math.min(28, Math.max(9, Math.round(store.state.settings.fontSize + dir)));
  updateSettings(store, { fontSize: next });
}

function updateSettings(
  store: AppStore,
  patch: Partial<Parameters<typeof api.setSettings>[0]>,
): void {
  const next = { ...store.state.settings, ...patch };
  store.setSettings(next);
  if (isInApp()) void api.setSettings(next).catch(() => {});
}

/** 트리 → 자동완성 문서 목록(이름 충돌 시 상대경로 포함). */
function wikiDocsOf(tree: import("./api").TreeNode[]): WikiDoc[] {
  const out: WikiDoc[] = [];
  const seen = new Map<string, number>();
  const walk = (nodes: import("./api").TreeNode[], prefix: string): void => {
    for (const n of nodes) {
      if (n.kind === "dir") {
        walk(n.children ?? [], prefix ? `${prefix}/${n.name}` : n.name);
      } else if (n.kind === "file") {
        const stem = n.stem ?? n.name;
        const count = (seen.get(stem) ?? 0) + 1;
        seen.set(stem, count);
        out.push({ name: stem, path: n.path });
      }
    }
  };
  walk(tree, "");
  // 동일 stem이 여러 개면 상대경로를 이름에 포함해 구분 표시(표시 전용).
  for (const d of out) {
    if ((seen.get(d.name) ?? 0) > 1) {
      const rel = d.path.split("/").slice(-3, -1).join("/");
      if (rel) d.name = `${d.name} (${rel})`;
    }
  }
  return out;
}

/** 워크스페이스 트리에서 태그 후보 수집(폴더 이름 → 태그). */
let wsTagCache: string[] | null = null;
let wsTagCacheKey = '';

function collectWorkspaceTags(tree: import('./api').TreeNode[]): string[] {
  const key = JSON.stringify(tree.map((n) => n.path));
  if (key === wsTagCacheKey && wsTagCache) return wsTagCache;
  wsTagCacheKey = key;
  const tags = new Set<string>();
  const walk = (nodes: import('./api').TreeNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'dir') {
        tags.add(n.name);
        walk(n.children ?? []);
      }
    }
  };
  walk(tree);
  wsTagCache = [...tags].sort();
  return wsTagCache;
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
