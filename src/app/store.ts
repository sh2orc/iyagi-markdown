// 앱 상태(탭·워크스페이스·설정·세션). React는 useStore로 구독한다.
// 에디터 자체(DOM)는 React 밖의 CodeMirror가 소유하며, 스토어는 EditorState만
// 보관한다(비활성 탭 View 해제, §7).
//
// 순수 로직(의존 주입형 IO)이라 단위 테스트가 가능하다.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type {
  DocMeta,
  LoadedDoc,
  RecentEntry,
  SessionState,
  Settings,
  TreeNode,
} from "../api";
import { applyPreviewConfig, createDocState, switchMode, type ViewMode } from "../editor/cm";
import { dirname } from "../paths";

export interface Tab {
  id: string;
  path: string | null;
  title: string;
  state: EditorState;
  mode: ViewMode;
  /** 디스크에 저장된 텍스트 — dirty 판정과 충돌 비교의 기준. */
  savedText: string;
  meta: DocMeta;
  savedMtime: number;
  scroll: number;
  cursorLine: number;
  cursorCol: number;
  /** 외부 변경 상태: null | "changed" | "removed" | "conflict". */
  conflict: null | "changed" | "removed" | "conflict";
}

export type ExportKind = "html" | "pdf" | "docx";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}

export interface AppStoreState {
  tabs: Tab[];
  activeId: string | null;
  workspace: string | null;
  tree: TreeNode[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  tocOpen: boolean;
  settings: Settings;
  theme: "light" | "dark";
  searchOpen: boolean;
  exportKind: ExportKind | null;
  recent: RecentEntry[];
  toasts: Toast[];
  busy: string | null;
  ready: boolean;
}

/** 저장·IO 인터페이스 — 테스트에서 가짜로 바꾼다. */
export interface StoreIO {
  readDocument(path: string): Promise<LoadedDoc>;
  writeDocument(path: string, text: string, meta: DocMeta): Promise<{ mtime: number; size: number }>;
  scanWorkspace(root: string): Promise<TreeNode[]>;
  saveSession(session: SessionState): Promise<void>;
  setAssetScope(path: string, recursive: boolean): Promise<void>;
  watchPaths(files: string[], dirs: string[]): Promise<void>;
  pushRecent?(path: string): Promise<void>;
  getSession?(): Promise<SessionState | null>;
}

let nextTabId = 1;
let nextToastId = 1;

export class AppStore {
  state: AppStoreState = {
    tabs: [],
    activeId: null,
    workspace: null,
    tree: [],
    sidebarOpen: true,
    sidebarWidth: 240,
    tocOpen: false,
    settings: defaultSettings(),
    theme: "light",
    searchOpen: false,
    exportKind: null,
    recent: [],
    toasts: [],
    busy: null,
    ready: false,
  };

  view: EditorView | null = null;
  private listeners = new Set<() => void>();
  private io: StoreIO;
  private sessionSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** 프런트가 저장한 뒤 잠깐 오는 외부 이벤트를 무시하기 위한 최근 저장 시각. */
  private lastSavedAt = 0;

  constructor(io: StoreIO) {
    this.io = io;
  }

  // — 구독 —

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): AppStoreState => this.state;

  private emit() {
    this.state = { ...this.state };
    for (const fn of this.listeners) fn();
  }

  // — 탭 —

  get active(): Tab | null {
    return this.state.tabs.find((t) => t.id === this.state.activeId) ?? null;
  }

  async openPath(path: string, mode?: ViewMode): Promise<void> {
    const existing = this.state.tabs.find((t) => t.path === path);
    if (existing) {
      this.activate(existing.id);
      return;
    }
    let doc: LoadedDoc;
    try {
      doc = await this.io.readDocument(path);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e), "error");
      return;
    }
    const tabMode = mode ?? this.state.settings.defaultMode;
    const tab: Tab = {
      id: `t${nextTabId++}`,
      path,
      title: baseName(path),
      state: createDocState(doc.text, tabMode),
      mode: tabMode,
      savedText: doc.text,
      meta: doc.meta,
      savedMtime: doc.mtime,
      scroll: 0,
      cursorLine: 1,
      cursorCol: 1,
      conflict: null,
    };
    this.state.tabs.push(tab);
    this.activate(tab.id);
    this.emit();
    void this.syncWatch();
    this.scheduleSessionSave();
  }

  newTab(): void {
    const tab: Tab = {
      id: `t${nextTabId++}`,
      path: null,
      title: "",
      state: createDocState("", this.state.settings.defaultMode),
      mode: this.state.settings.defaultMode,
      savedText: "",
      meta: { hadBom: false, crlf: false },
      savedMtime: 0,
      scroll: 0,
      cursorLine: 1,
      cursorCol: 1,
      conflict: null,
    };
    this.state.tabs.push(tab);
    this.activate(tab.id);
    this.emit();
    this.scheduleSessionSave();
  }

  /** 활성 탭 기록(스크롤 등) 후 다른 탭으로. */
  activate(id: string): void {
    const prev = this.active;
    if (prev && this.view) {
      prev.scroll = this.view.scrollDOM.scrollTop;
      prev.state = this.view.state;
    }
    this.state.activeId = id;
    const tab = this.active;
    if (tab && this.view) {
      this.view.setState(tab.state);
      this.view.scrollDOM.scrollTop = tab.scroll;
      this.applyConfig();
      if (this.state.searchOpen) this.emitSearchRefresh();
    }
    this.emit();
    this.scheduleSessionSave();
  }

  closeTab(id: string): void {
    const idx = this.state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    this.state.tabs.splice(idx, 1);
    if (this.state.activeId === id) {
      const next = this.state.tabs[Math.min(idx, this.state.tabs.length - 1)];
      this.state.activeId = next?.id ?? null;
      const tab = this.active;
      if (tab && this.view) {
        this.view.setState(tab.state);
        this.view.scrollDOM.scrollTop = tab.scroll;
        this.applyConfig();
      }
    }
    this.emit();
    void this.syncWatch();
    this.scheduleSessionSave();
  }

  /** 활성 탭의 EditorState를 스토어에 동기화(포커스 잃기 전 등). */
  syncActiveState(): void {
    const tab = this.active;
    if (tab && this.view) {
      tab.state = this.view.state;
      tab.scroll = this.view.scrollDOM.scrollTop;
    }
  }

  // — 모드 —

  setMode(mode: ViewMode): void {
    const tab = this.active;
    if (!tab) return;
    tab.mode = mode;
    if (this.view) switchMode(this.view, mode);
    this.emit();
    this.scheduleSessionSave();
  }

  toggleReadEdit(): void {
    const tab = this.active;
    if (!tab) return;
    this.setMode(tab.mode === "read" ? "edit" : "read");
  }

  cycleTabs(forward: boolean): void {
    const tabs = this.state.tabs;
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.id === this.state.activeId);
    const next = (idx + (forward ? 1 : tabs.length - 1)) % tabs.length;
    this.activate(tabs[next].id);
  }

  moveTab(from: number, to: number): void {
    const tabs = [...this.state.tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    this.state.tabs = tabs;
    this.emit();
    this.scheduleSessionSave();
  }

  // — 문서 변경 반영(CodeMirror 리스너에서) —

  onDocChanged(): void {
    const tab = this.active;
    if (!tab || !this.view) return;
    tab.state = this.view.state;
    const sel = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(sel.head);
    tab.cursorLine = line.number;
    tab.cursorCol = sel.head - line.from + 1;
    // 상태 줄(줄/칸·더티 점) 갱신 — 상태 객체를 새로 만들어 구독자에게 알린다.
    this.emit();
  }

  // — 저장 —

  async saveActive(saveAsPath?: string): Promise<boolean> {
    const tab = this.active;
    if (!tab) return false;
    this.syncActiveState();
    const path = saveAsPath ?? tab.path;
    if (!path) return false; // Save As 경로는 호출자(UI)가 지정
    const text = tab.state.doc.toString();
    try {
      const out = await this.io.writeDocument(path, text, tab.meta);
      tab.path = path;
      tab.title = baseName(path);
      tab.savedText = text;
      tab.savedMtime = out.mtime;
      tab.conflict = null;
      this.lastSavedAt = Date.now();
      this.emit();
      void this.syncWatch();
      this.scheduleSessionSave();
      return true;
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e), "error");
      return false;
    }
  }

  // — 외부 변경 —

  externalChange(path: string, kind: "changed" | "removed"): void {
    // 방금 저장한 파일이면 무시(self-write는 Rust가 이미 걸렀지만 이중 방어).
    if (Date.now() - this.lastSavedAt < 2000 && this.active?.path === path) return;
    const tab = this.state.tabs.find((t) => t.path === path);
    if (!tab) {
      // 워크스페이스 트리 갱신.
      void this.refreshTree();
      return;
    }
    this.syncActiveState();
    if (kind === "removed") {
      tab.conflict = "removed";
      this.emit();
      return;
    }
    const dirty = tab.state.doc.toString() !== tab.savedText;
    if (dirty) {
      tab.conflict = "conflict";
      this.emit();
    } else {
      // 수정 중이 아니면 자동 다시 읽기(커서·스크롤 보존).
      void this.reloadTab(tab.id, true);
    }
    void this.refreshTree();
  }

  async reloadTab(id: string, keepPosition: boolean): Promise<void> {
    const tab = this.state.tabs.find((t) => t.id === id);
    if (!tab?.path) return;
    try {
      const doc = await this.io.readDocument(tab.path);
      const isActive = tab.id === this.state.activeId;
      if (isActive && this.view) {
        const sel = this.view.state.selection.main.head;
        const scroll = keepPosition ? this.view.scrollDOM.scrollTop : tab.scroll;
        const newSel = Math.min(sel, doc.text.length);
        tab.state = this.view.state.update({
          changes: { from: 0, to: this.view.state.doc.length, insert: doc.text },
          selection: { anchor: newSel },
        }).state;
        this.view.setState(tab.state);
        this.view.scrollDOM.scrollTop = scroll;
      } else {
        const sel = Math.min(tab.state.selection.main.head, doc.text.length);
        tab.state = tab.state.update({
          changes: { from: 0, to: tab.state.doc.length, insert: doc.text },
          selection: { anchor: sel },
        }).state;
      }
      tab.savedText = doc.text;
      tab.meta = doc.meta;
      tab.savedMtime = doc.mtime;
      tab.conflict = null;
      this.emit();
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e), "error");
    }
  }

  keepMine(id: string): void {
    const tab = this.state.tabs.find((t) => t.id === id);
    if (!tab) return;
    // 다음 저장이 디스크를 덮어쓴다 — dirty 상태를 유지하고 충돌 표시만 지운다.
    tab.conflict = null;
    this.emit();
  }

  // — 워크스페이스 —

  async openWorkspace(dir: string): Promise<void> {
    this.state.workspace = dir;
    this.state.sidebarOpen = true;
    await this.refreshTree();
    void this.io.setAssetScope(dir, true).catch(() => {});
    void this.syncWatch();
    this.emit();
    this.scheduleSessionSave();
  }

  closeWorkspace(): void {
    this.state.workspace = null;
    this.state.tree = [];
    this.emit();
    void this.syncWatch();
    this.scheduleSessionSave();
  }

  async refreshTree(): Promise<void> {
    if (!this.state.workspace) return;
    try {
      this.state.tree = await this.io.scanWorkspace(this.state.workspace);
      this.emit();
    } catch {
      // 폴더가 사라졌을 수 있다 — 조용히 둔다.
    }
  }

  /** 감시 대상 동기화: 열린 문서들 + 워크스페이스 루트. */
  async syncWatch(): Promise<void> {
    this.syncActiveState();
    const files = this.state.tabs
      .map((t) => t.path)
      .filter((p): p is string => !!p);
    const dirs = this.state.workspace ? [this.state.workspace] : [];
    try {
      await this.io.watchPaths(files, dirs);
    } catch {
      // 감시 실패는 치명적이지 않다.
    }
  }

  // — 설정·테마 —

  setSettings(settings: Settings): void {
    this.state.settings = settings;
    this.state.theme = resolveTheme(settings);
    this.applyConfig();
    this.emit();
  }

  setTheme(theme: "light" | "dark"): void {
    this.state.theme = theme;
    this.applyConfig();
    this.emit();
  }

  applyConfig(): void {
    if (!this.view) return;
    const tab = this.active;
    const baseDir = tab?.path ? dirname(tab.path) : this.state.workspace ?? "";
    applyPreviewConfig(this.view, {
      baseDir,
      remoteImages: this.state.settings.remoteImages,
      showImages: this.state.settings.showImages,
      theme: this.state.theme,
    });
  }

  // — 세션 —

  async restoreSession(session: SessionState): Promise<void> {
    this.state.sidebarOpen = session.sidebarOpen;
    this.state.sidebarWidth = session.sidebarWidth ?? 240;
    this.state.tocOpen = session.tocOpen;
    if (session.workspace) await this.openWorkspace(session.workspace);
    for (const t of session.tabs) {
      if (!t.path) continue;
      try {
        await this.openPath(t.path, t.mode);
        const tab = this.state.tabs.find((x) => x.path === t.path);
        if (tab) {
          const sel = Math.min(t.cursor, tab.state.doc.length);
          tab.state = tab.state.update({ selection: { anchor: sel } }).state;
          tab.scroll = t.scroll;
        }
      } catch {
        // 없는 파일은 조용히 건너뛴다.
      }
    }
    if (session.active) {
      const tab = this.state.tabs.find((t) => t.path === session.active);
      if (tab) this.activate(tab.id);
    }
    this.emit();
  }

  buildSession(): SessionState {
    this.syncActiveState();
    return {
      version: 1,
      tabs: this.state.tabs.map((t) => ({
        path: t.path,
        mode: t.mode,
        cursor: t.state.selection.main.head,
        scroll: Math.round(t.scroll),
      })),
      active: this.active?.path ?? null,
      workspace: this.state.workspace,
      sidebarOpen: this.state.sidebarOpen,
      sidebarWidth: this.state.sidebarWidth,
      tocOpen: this.state.tocOpen,
      window: this.windowRect,
    };
  }

  /** 창 위치·크기 — App이 이동/리사이즈 때마다 기록한다(세션 복원용). */
  windowRect: SessionState["window"] = null;

  setWindowRect(rect: NonNullable<SessionState["window"]>): void {
    this.windowRect = rect;
  }

  scheduleSessionSave(): void {
    if (this.sessionSaveTimer) clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = setTimeout(() => {
      this.sessionSaveTimer = null;
      void this.io.saveSession(this.buildSession()).catch(() => {});
    }, 800);
  }

  // — UI 조각 —

  setSidebar(open: boolean): void {
    this.state.sidebarOpen = open;
    this.emit();
    this.scheduleSessionSave();
  }

  setSidebarWidth(width: number): void {
    this.state.sidebarWidth = width;
    this.emit();
    this.scheduleSessionSave();
  }

  setToc(open: boolean): void {
    this.state.tocOpen = open;
    this.emit();
    this.scheduleSessionSave();
  }

  setSearchOpen(open: boolean): void {
    this.state.searchOpen = open;
    this.emit();
  }

  setExportKind(kind: ExportKind | null): void {
    this.state.exportKind = kind;
    this.emit();
  }

  setBusy(text: string | null): void {
    this.state.busy = text;
    this.emit();
  }

  setRecent(entries: RecentEntry[]): void {
    this.state.recent = entries;
    this.emit();
  }

  toast(text: string, kind: "info" | "error" = "info"): void {
    const t = { id: nextToastId++, text, kind };
    this.state.toasts = [...this.state.toasts, t];
    this.emit();
    setTimeout(() => {
      this.state.toasts = this.state.toasts.filter((x) => x.id !== t.id);
      this.emit();
    }, kind === "error" ? 6000 : 2600);
  }

  private emitSearchRefresh(): void {
    // 탭을 바꿀 때 검색 상태는 새 문서 기준으로 초기화된다(패널이 다시 친다).
  }
}

export function defaultSettings(): Settings {
  return {
    theme: "auto",
    fontSize: 15,
    lineWidth: 760,
    defaultMode: "edit",
    remoteImages: true,
    language: "auto",
    showImages: true,
    logLevel: "info",
  };
}

export function resolveTheme(settings: Settings): "light" | "dark" {
  if (settings.theme === "light") return "light";
  if (settings.theme === "dark") return "dark";
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

export function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
