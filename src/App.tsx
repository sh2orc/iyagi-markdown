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
import { setPhrases } from "./app/phrases";
import { invalidateLinkPreviews } from "./editor/linkPreview";
import { stripFrontMatter } from "./editor/frontmatter";
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
import { setImageResizeHandler, setImageViewerHandler, setTableHeaderClickHandler } from "./editor/widgets";
import { setTableWidthsSaveHandler } from "./editor/livePreview";
import { setTagClickHandler } from "./editor/cm";
import { setWikiDocsProvider, setTagListProvider, type WikiDoc } from "./editor/wikiComplete";
import { SettingsSheet } from "./components/SettingsSheet";
import { StylePanel } from "./components/StylePanel";
import { PrintPreview } from "./components/PrintPreview";
import { ShortcutsPanel } from "./components/ShortcutsPanel";
import { StatsPanel } from "./components/StatsPanel";
import { CommandPalette } from "./components/CommandPalette";
import { VersionsPanel } from "./components/VersionsPanel";
import { BacklinksPanel } from "./components/BacklinksPanel";
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
  const [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [pdfPageNumbers, setPdfPageNumbers] = useState(true);

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
    diffOpen ||
    state.exportKind ||
    state.busy ||
    state.tabs.some((x) => x.conflict === "conflict" || x.conflict === "removed")
  );
  useEffect(() => {
    if (editorHost.current) editorHost.current.inert = modalOpen;
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
      saveFailed: t.saveFailed,
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
    setImageViewerHandler((src, alt) => setViewer({ src, alt }));
    setTableWidthsSaveHandler((lineNo, widths) => store.setTableWidths(lineNo, widths));
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
    const name = tab.path ? tab.title.replace(/\.(md|markdown)$/i, "") : "untitled";
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
      const name = (tab.path ? tab.title : "untitled").replace(/\.(md|markdown)$/i, "");
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
        if (kind === "html") {
          const html = await buildExportHtml(text, {
            title: tab.path ? tab.title : name,
            baseDir,
            theme: store.state.theme,
            style: exportStyleOf(tab),
            readBytes: readBytesForExport,
            wikiResolve,
          });
          await api.writeExportFile(out, html);
        } else if (kind === "pdf") {
          const html = await buildExportHtml(text, {
            title: tab.path ? tab.title : name,
            baseDir,
            theme: store.state.theme,
            forPdf: true,
            marginMm: opts.marginMm,
            scale: opts.scale,
            style: exportStyleOf(tab),
            readBytes: readBytesForExport,
            wikiResolve,
          });
          await api.exportPdf(html, { ...opts, pageNumbers: pdfPageNumbers }, out);
        } else if (kind === "epub") {
          // EPUB — 본문 조각을 XHTML로(빈 태그 자가 폐쇄) + 최소 가독 CSS.
          const { body } = await renderMarkdownBody(text, {
            title: tab.path ? tab.title : name,
            baseDir,
            theme: store.state.theme,
            readBytes: readBytesForExport,
          });
          // 전체를 한 번 렌더한 HTML을 <h1> 경계로 챕터 분할(각주는 마지막 챕터에).
          const chapters = epubChapterInputs(splitEpubChapters(body));
          // 표지 — 문서의 첫 로컬 이미지(없으면 생략).
          const coverPath = firstLocalImage(text, baseDir);
          await api.exportEpub(
            chapters,
            tab.path ? tab.title : name,
            lang === "ko" ? "ko" : "en",
            EPUB_CSS,
            coverPath,
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
          };
          await api.exportDocx(text, manifest, out, baseDir);
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
      if (settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [closeAsk, state.exportKind, styleOpen, settingsOpen, store]);

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
          opener.openUrl(target.kind === "mail" ? target.url : target.url).catch(() => {}),
        );
      } else if (target.kind === "anchor") {
        scrollToAnchor(target.id);
      }
    });
    return () => setLinkClickHandler(null);
  }, [store, scrollToAnchor]);

  const activeTab = state.tabs.find((x) => x.id === state.activeId) ?? null;
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
          <TabBar store={store} t={t} onClose={(tab) => void closeTabWithConfirm(tab)} />
          <Toolbar store={store} t={t} />
          <SearchPanel store={store} view={editorView.current} t={t} open={state.searchOpen} />
          <div className={`editor-area ${activeTab?.mode === "read" ? "read-mode" : ""}`}>
            <MiniToolbar store={store} t={t} />
            <div className="editor-host" ref={editorHost} />
            {!state.ready && <div className="app-splash">{t.loading}</div>}
            {state.ready && state.tabs.length === 0 && (
              <div className="app-empty">
                <div className="app-empty-mark">M↓</div>
                <div className="app-empty-title">{t.emptyNoDoc}</div>
                <div className="app-empty-hint">{t.emptyNoDocHint}</div>
              </div>
            )}
          </div>
          <StatusBar store={store} t={t} onOpenSettings={() => setSettingsOpen(true)} onOpenStyle={() => setStyleOpen(true)} onOpenStats={() => setStatsOpen(true)} onOpenBacklinks={() => setBacklinksOpen(true)} />
        </main>
        <TocPanel store={store} t={t} open={state.tocOpen} />
      </div>

      {/* 오버레이 */}
      {state.busy && (
        <div className="overlay">
          <div className="overlay-card">
            <div className="spinner" />
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
          pageNumbers={pdfPageNumbers}
          onTogglePageNumbers={setPdfPageNumbers}
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
      {printOpen && (
        <PrintPreview
          store={store}
          t={t}
          onExport={(kind, opts) => {
            setPrintOpen(false);
            void runExport(kind, opts);
          }}
          onCancel={() => setPrintOpen(false)}
        />
      )}
      <ContextMenu store={store} t={t} />
      {diffOpen && <DiffPanel store={store} t={t} onClose={() => setDiffOpen(false)} />}
      {viewer && <ImageViewer src={viewer.src} alt={viewer.alt} t={t} onClose={() => setViewer(null)} />}
      <div className="toasts">
        {state.toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind} ${toast.leaving ? "is-leaving" : ""}`}>
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
  } | null;
}): {
  font: "system" | "serif" | "round" | "mono";
  sizePt: number;
  lineHeight: number;
  firstLineIndent: boolean;
  textAlign: "left" | "center" | "right" | "justify";
  accent: string | null;
} {
  const ds = tab.docStyle;
  return {
    font: ds?.font ?? "system",
    sizePt: ds && ds.fontSize > 0 ? ds.fontSize : 11,
    lineHeight: ds?.lineHeight ?? 0,
    firstLineIndent: ds?.firstLineIndent ?? false,
    textAlign: ds?.textAlign ?? "left",
    accent: ds?.accent ?? null,
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
