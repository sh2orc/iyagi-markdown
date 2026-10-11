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
import { setLinkClickHandler, setViewListener } from "./editor/cm";
import { buildDocxManifest, buildExportHtml } from "./export/html";
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
import { SettingsSheet } from "./components/SettingsSheet";
import { StylePanel } from "./components/StylePanel";

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
};

export interface PdfExportOptions {
  paper: "a4" | "letter" | "a5";
  orientation: "portrait" | "landscape";
  marginMm: number;
  scale: number;
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

  const lang: Lang = useMemo(() => {
    if (state.settings.language === "ko") return "ko";
    if (state.settings.language === "en") return "en";
    return detectBrowserLang();
  }, [state.settings.language]);
  const t = useMemo(() => makeT(lang), [lang]);

  // — 초기화 —
  useEffect(() => {
    let disposed = false;
    initBridge();
    store.state.ready = false;
    (async () => {
      try {
        const settings = await api.getSettings();
        store.setSettings(settings);
      } catch {
        /* 브라우저 개발 — 기본값 */
      }
      try {
        const session = await api.getSession();
        if (session && !disposed) await store.restoreSession(session);
      } catch {
        /* 무시 */
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

  // — 에디터 뷰 수명(탭 전환은 setState) —
  useEffect(() => {
    if (!editorHost.current || editorView.current) return;
    const view = new EditorView({ parent: editorHost.current });
    editorView.current = view;
    store.view = view;
    store.hostEl = editorHost.current;
    setViewListener(() => store.onDocChanged());
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
    if (tab.path && tab.state.doc.toString() === tab.savedText) return; // 무수정 저장 안 함(§4-2)
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

  const runExport = useCallback(
    async (kind: ExportKind, opts: PdfExportOptions) => {
      const tab = store.active;
      if (!tab) return;
      const text = tab.state.doc.toString();
      const name = (tab.path ? tab.title : "untitled").replace(/\.(md|markdown)$/i, "");
      const ext = kind === "html" ? "html" : kind === "pdf" ? "pdf" : "docx";
      const out = await pickSave(`${name}.${ext}`, ext);
      if (!out) return;
      store.setBusy(t.exportPreparing);
      try {
        const baseDir = tab.path
          ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/"
          : store.state.workspace ?? "";
        if (kind === "html") {
          const html = await buildExportHtml(text, {
            title: tab.path ? tab.title : name,
            baseDir,
            theme: store.state.theme,
            readBytes: readBytesForExport,
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
            readBytes: readBytesForExport,
          });
          await api.exportPdf(html, opts, out);
        } else {
          const manifest = await buildDocxManifest(text);
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
      const dirty = tab.state.doc.toString() !== tab.savedText;
      if (dirty) {
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
      if (id.startsWith("recent:")) {
        void store.openPath(id.slice("recent:".length));
        return;
      }
      switch (id) {
        case "doc-style":
          setStyleOpen(true);
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
          store.setExportKind("pdf");
          break;
        case "export-html":
        case "export-pdf":
        case "export-docx":
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
    keep(onFsEvent((e) => store.externalChange(e.path, e.kind)));
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
        store.setSearchOpen(true);
      } else if (key === "s") {
        e.preventDefault();
        if (e.shiftKey) void saveAs();
        else void saveActive();
      } else if (key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);

    // 파일 드래그 앤 드롭(Tauri 경로 이벤트).
    if (isInApp()) {
      void import("@tauri-apps/api/event").then(async (ev) => {
        const u = await ev.listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
          const paths = e.payload.paths.filter((p) => /\.(md|markdown)$/i.test(p));
          for (const p of paths) void store.openPath(p);
        });
        if (!disposed) unlistens.push(u);
      });
      // 창 닫기 요청 — 더티 확인 후 세션 저장하고 닫는다.
      void webviewWindowApi().then(async (win) => {
        const u = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          const dirty = store.state.tabs.filter((x) => x.state.doc.toString() !== x.savedText);
          if (dirty.length > 0) {
            const ok = await new Promise<boolean>((resolve) => setCloseAsk(() => resolve));
            setCloseAsk(null);
            if (!ok) return;
          }
          await api.saveSession(store.buildSession()).catch(() => {});
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

  // — CSS 변수로 테마·글꼴 반영 —
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = state.theme;
    root.style.setProperty("--md-font-size", `${state.settings.fontSize}px`);
    root.style.setProperty(
      "--md-line-width",
      state.settings.lineWidth > 0 ? `${state.settings.lineWidth}px` : "100%",
    );
  }, [state.theme, state.settings.fontSize, state.settings.lineWidth]);

  // — 앵커 스크롤(링크 클릭) —
  const scrollToAnchor = useCallback(
    (id: string) => {
      const view = editorView.current;
      if (!view) return;
      const text = view.state.doc.toString();
      const target = collectHeadings(text).find((h) => h.slug === id || h.slug.startsWith(id));
      if (target) {
        let pos = 0;
        let line = 1;
        for (const l of text.split("\n")) {
          if (pos >= target.pos) break;
          pos += l.length + 1;
          line++;
        }
        const l = view.state.doc.line(Math.min(line, view.state.doc.lines));
        view.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
      }
    },
    [],
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
        {state.sidebarOpen && (
          <Sidebar
            store={store}
            tree={state.tree}
            workspace={state.workspace}
            activePath={activeTab?.path ?? null}
            t={t}
          />
        )}
        <main className="app-main">
          <TabBar store={store} t={t} onClose={(tab) => void closeTabWithConfirm(tab)} />
          <Toolbar store={store} t={t} />
          {state.searchOpen && editorView.current && (
            <SearchPanel store={store} view={editorView.current} t={t} />
          )}
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
          <StatusBar store={store} t={t} onOpenSettings={() => setSettingsOpen(true)} onOpenStyle={() => setStyleOpen(true)} />
        </main>
        {state.tocOpen && <TocPanel store={store} t={t} />}
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
      <ContextMenu store={store} t={t} />
      <div className="toasts">
        {state.toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
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
  patch: Partial<Parameters<typeof api.setSettings>[0]>,
): void {
  const next = { ...store.state.settings, ...patch };
  store.setSettings(next);
  if (isInApp()) void api.setSettings(next).catch(() => {});
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
