// 앱 상태(탭·워크스페이스·설정·세션). React는 useStore로 구독한다.
// 에디터 자체(DOM)는 React 밖의 CodeMirror가 소유하며, 스토어는 EditorState만
// 보관한다(비활성 탭 View 해제, §7).
//
// 순수 로직(의존 주입형 IO)이라 단위 테스트가 가능하다.

import { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import type {
  DocMeta,
  DocStyle,
  LoadedDoc,
  RecentEntry,
  SessionState,
  Settings,
  TreeNode,
} from "../api";
import { applyDocStyle, DEFAULT_DOC_STYLE as DEFAULT_DOC_STYLE_T } from "./docStyle";
import { applyPreviewConfig, createDocState, smoothScrollIntoView, switchMode, type ViewMode } from "../editor/cm";
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
  /** 문서별 스타일(SQLite 사이드카). 없으면 기본. */
  docStyle: DocStyle | null;
  /** 커서 위치의 활성 서식(도구모음 반영용). */
  marks: { bold: boolean; italic: boolean; strike: boolean; code: boolean; link: boolean };
  /** 선택 통계(상태줄) — 선택 중일 때만 표시. */
  selChars: number;
  /** 책갈피 줄 번호(SQLite 사이드카 — 원문 불변). */
  bookmarks: number[];
  /** 저장 안 됨 표시 — 입력마다 O(문서) 비교 대신 증분 유지(정확성: 길이가
   *  같을 때만 문자열 비교로 확정한다). */
  dirty: boolean;
  /** 단어 수·글자 수 — 상태 줄용. 편집 델타로 증분 갱신한다. */
  words: number;
  chars: number;
}

export type ExportKind = "html" | "pdf" | "docx";

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
  /** 퇴장 애니메이션 중. */
  leaving?: boolean;
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
  docStyleGet?(path: string): Promise<string | null>;
  docStyleSet?(path: string, styleJson: string): Promise<void>;
  bookmarkList?(path: string): Promise<number[]>;
  bookmarkAdd?(path: string, lineNo: number): Promise<void>;
  bookmarkRemove?(path: string, lineNo: number): Promise<void>;
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
  /** UI 문구 주입(App이 설치) — 스토어는 i18n 모듈을 몰라도 된다. */
  phrases: { bigDocSource: string } | null = null;
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

  /** 창 제목 갱신 — "파일명" / "파일명 — 수정됨" / 앱 이름(Word 방식). */
  private updateWindowTitle(): void {
    void (async () => {
      if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
      try {
        const w = await import("@tauri-apps/api/window").then((m) => m.getCurrentWindow());
        const tab = this.active;
        if (!tab || !tab.path) {
          void w.setTitle("IYAGI Markdown");
          return;
        }
        void w.setTitle(tab.dirty ? `${tab.title} — ✕` : tab.title);
      } catch {
        /* 제목은 부가 기능 */
      }
    })();
  }

  private emit() {
    if (this.emitRaf) {
      // 예약된 rAF emit을 즉시 emit으로 흡수한다(중복 렌더 방지).
      cancelAnimationFrame(this.emitRaf);
      this.emitRaf = 0;
    }
    this.state = { ...this.state };
    this.updateWindowTitle();
    for (const fn of this.listeners) fn();
  }

  private emitRaf = 0;

  /** 프레임 단위로 모아 내보낸다 — 연속 입력이 한 프레임에 렌더 한 번으로 끝난다. */
  private scheduleEmit() {
    if (this.emitRaf) return;
    if (typeof requestAnimationFrame !== "function") {
      this.emit();
      return;
    }
    this.emitRaf = requestAnimationFrame(() => {
      this.emitRaf = 0;
      this.emit();
    });
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
    // §7: 임계(1MB) 초과 문서는 장식 비용이 커진다 — 소스 모드로 열고 알린다.
    const LARGE_DOC = 1_000_000;
    const forced = doc.text.length > LARGE_DOC && !mode ? ("source" as const) : null;
    const tabMode: ViewMode = mode ?? forced ?? this.state.settings.defaultMode;
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
      docStyle: null,
      marks: { bold: false, italic: false, strike: false, code: false, link: false },
      selChars: 0,
      bookmarks: [],
      dirty: false,
      words: countWords(doc.text),
      chars: doc.text.length,
    };
    this.state.tabs.push(tab);
    // 책갈피 사이드카 로드.
    if (path) {
      void this.io.bookmarkList?.(path).then((lines) => {
        tab.bookmarks = lines;
        if (this.state.activeId === tab.id) {
          this.applyConfig(); // 줄 배지 렌더 반영
          this.emit();
        }
      });
    }
    // 문서별 스타일 사이드카 로드(SQLite).
    if (path && this.io.docStyleGet) {
      void this.io.docStyleGet(path).then((json) => {
        if (json) {
          try {
            tab.docStyle = { ...DEFAULT_DOC_STYLE_T, ...(JSON.parse(json) as DocStyle) };
            if (this.state.activeId === tab.id) this.applyDocStyleVars();
          } catch {
            /* 손상된 스타일은 무시 */
          }
        }
      });
    }
    if (forced) {
      this.toast(this.phrases?.bigDocSource ?? "Large document — opened in source mode for responsiveness.", "info");
    }
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
      docStyle: null,
      marks: { bold: false, italic: false, strike: false, code: false, link: false },
      selChars: 0,
      bookmarks: [],
      dirty: false,
      words: 0,
      chars: 0,
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
      this.restoreScroll(tab.scroll);
      this.applyConfig();
      if (this.state.searchOpen) this.emitSearchRefresh();
    }
    this.emit();
    this.scheduleSessionSave();
  }

  /** setState 직후 스크롤 복원 — 큰 문서는 높이 추정이 갱신되기 전이라
   *  scrollTop이 잘릴 수 있다. 즉시 한 번, 측정 마친 뒤 한 번 더 맞춘다. */
  private restoreScroll(top: number): void {
    const view = this.view;
    if (!view) return;
    view.scrollDOM.scrollTop = top;
    view.requestMeasure({
      read: () => null,
      write: () => {
        const v = this.view;
        if (v && Math.abs(v.scrollDOM.scrollTop - top) > 1) v.scrollDOM.scrollTop = top;
      },
    });
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
        this.restoreScroll(tab.scroll);
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

  onDocChanged(update: ViewUpdate): void {
    const tab = this.active;
    if (!tab || !this.view) return;
    tab.state = this.view.state;
    const sel = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(sel.head);
    tab.cursorLine = line.number;
    tab.cursorCol = sel.head - line.from + 1;
    tab.marks = marksAt(this.view.state, sel.head, sel.to);
    // 선택 통계(Word 상태 표시줄) — 증분 카운터 재사용.
    tab.selChars = sel.empty ? 0 : this.view.state.sliceDoc(sel.from, sel.to).length;
    if (update.docChanged) {
      // 통계는 편집 델타로 증분 갱신 — 키 입력마다 문서 전체를 훑지 않는다.
      const prevDoc = update.startState.doc;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        const removed = toA > fromA ? prevDoc.sliceString(fromA, toA) : "";
        const text = inserted.toString();
        tab.words += countWords(text) - countWords(removed);
        tab.chars += text.length - removed.length;
      });
      // dirty: 길이가 다르면 무조건 dirty, 같을 때만(되돌리기 복귀 등) 문자열로 확정.
      const doc = this.view.state.doc;
      if (doc.length !== tab.savedText.length) tab.dirty = true;
      else tab.dirty = doc.toString() !== tab.savedText;
    }
    // 초안 자동 저장(Word 자동 저장) — 입력이 멈춘 뒤 저장. 무수정이면 저장하지
    // 않는다(§4-2). 원자적 저장 경로 그대로.
    if (this.state.settings.autosave && tab.path) {
      if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
      this.autosaveTimer = setTimeout(() => {
        this.autosaveTimer = null;
        const t = this.active;
        if (t?.path && t.dirty) {
          void this.saveActive();
        }
      }, 1500);
    }
    // 상태 줄(줄/칸·더티 점) 갱신 — rAF로 모아 프레임당 한 번 렌더한다.
    this.scheduleEmit();
  }

  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

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
      tab.dirty = false;
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
    const dirty = tab.dirty;
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
        this.restoreScroll(scroll);
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
      tab.dirty = false;
      tab.words = countWords(doc.text);
      tab.chars = doc.text.length;
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
      imageWidths: tab?.docStyle?.imageWidths ?? {},
      bookmarks: tab?.bookmarks ?? [],
    });
    this.applyDocStyleVars();
  }

  /** 문서별 스타일을 에디터 컨테이너 CSS 변수로(호스트는 App이 등록한다). */
  hostEl: HTMLElement | null = null;

  applyDocStyleVars(): void {
    if (!this.hostEl) return;
    const tab = this.active;
    applyDocStyle(this.hostEl, tab?.docStyle ?? null, this.state.settings.fontSize);
  }

  /** 책갈피 토글 — 현재 커서 줄(원문 불변 — SQLite 사이드카). */
  toggleBookmark(): void {
    const tab = this.active;
    if (!tab?.path || !this.view) return;
    const line = this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
    const has = tab.bookmarks.includes(line);
    tab.bookmarks = has ? tab.bookmarks.filter((l) => l !== line) : [...tab.bookmarks, line].sort((a, b) => a - b);
    // 에디터 설정(config)에 반영해야 줄 배지가 바로 다시 그려진다.
    this.applyConfig();
    this.emit();
    void (has ? this.io.bookmarkRemove?.(tab.path, line) : this.io.bookmarkAdd?.(tab.path, line));
  }

  /** 책갈피로 이동 — 목차·앵커와 같은 부드러운 스크롤. */
  gotoBookmark(line: number): void {
    if (!this.view) return;
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(line, 1), doc.lines));
    smoothScrollIntoView(this.view, l.from);
  }

  /** 이미지 표시 폭 변경(원문 불변 — 사이드카에만 저장). */
  setImageWidth(src: string, pct: number): void {
    const tab = this.active;
    if (!tab) return;
    const style: DocStyle = {
      ...(tab.docStyle ?? DEFAULT_DOC_STYLE_T),
      imageWidths: { ...(tab.docStyle?.imageWidths ?? {}), [src]: pct },
    };
    this.setDocStyle(style);
  }

  /** 활성 문서 스타일 변경 — 즉시 적용 + SQLite 저장(원문 불변).
   *  디스크 저장은 디바운스 — 슬라이더를 끌 때 매 틱마다 쓰지 않는다. */
  setDocStyle(style: DocStyle): void {
    const tab = this.active;
    if (!tab) return;
    tab.docStyle = style;
    this.applyDocStyleVars();
    this.emit();
    if (this.docStyleTimer) clearTimeout(this.docStyleTimer);
    this.docStyleTimer = setTimeout(() => {
      this.docStyleTimer = null;
      const t = this.active;
      if (t?.path && this.io.docStyleSet) {
        void this.io.docStyleSet(t.path, JSON.stringify(t.docStyle)).catch(() => {});
      }
    }, 350);
  }

  private docStyleTimer: ReturnType<typeof setTimeout> | null = null;

  // — 세션 —

  async restoreSession(session: SessionState): Promise<void> {
    this.state.sidebarOpen = session.sidebarOpen;
    this.state.sidebarWidth = session.sidebarWidth ?? 240;
    this.state.tocOpen = session.tocOpen;
    if (session.workspace) await this.openWorkspace(session.workspace);
    // 문서 읽기는 병렬로(순차 열기보다 첫 화면이 빨라진다). 탭 순서·활성은 유지.
    const entries = session.tabs.filter((t) => t.path);
    const loaded = await Promise.all(
      entries.map(async (t) => {
        try {
          const doc = await this.io.readDocument(t.path!);
          return { t, doc };
        } catch {
          return null; // 없는 파일은 조용히 건너뛴다.
        }
      }),
    );
    for (const item of loaded) {
      if (!item) continue;
      const { t, doc } = item;
      const tabMode: ViewMode = t.mode;
      const tab: Tab = {
        id: `t${nextTabId++}`,
        path: t.path!,
        title: baseName(t.path!),
        state: createDocState(doc.text, tabMode),
        mode: tabMode,
        savedText: doc.text,
        meta: doc.meta,
        savedMtime: doc.mtime,
        scroll: t.scroll,
        cursorLine: 1,
        cursorCol: 1,
        conflict: null,
        docStyle: null,
        marks: { bold: false, italic: false, strike: false, code: false, link: false },
        selChars: 0,
        bookmarks: [],
        dirty: false,
        words: countWords(doc.text),
        chars: doc.text.length,
      };
      this.state.tabs.push(tab);
      // 커서 복원 — update는 Transaction을 돌려주고 그 .state가 새 상태다.
      const tr = tab.state.update({ selection: { anchor: Math.min(t.cursor, tab.state.doc.length) } });
      tab.state = tr.state;
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
    const t = { id: nextToastId++, text, kind, leaving: false };
    this.state.toasts = [...this.state.toasts, t];
    this.emit();
    setTimeout(() => {
      // 퇴장 애니메이션(0.18s)을 보여준 뒤 치운다 — 깜빡 사라지지 않게.
      this.state.toasts = this.state.toasts.map((x) =>
        x.id === t.id ? { ...x, leaving: true } : x,
      );
      this.emit();
      setTimeout(() => {
        this.state.toasts = this.state.toasts.filter((x) => x.id !== t.id);
        this.emit();
      }, 200);
    }, kind === "error" ? 6000 : 2600);
  }

  private emitSearchRefresh(): void {
    // 탭을 바꿀 때 검색 상태는 새 문서 기준으로 초기화된다(패널이 다시 친다).
  }
}

/** 단어 수 — 한글은 음절을, 라틴은 단어를 센다(대략적 지표).
 *  편집 델타의 삽입·삭제 조각에만 돌리므로 입력 비용은 입력량에 비례한다. */
export function countWords(text: string): number {
  const cjk = (text.match(/[가-힣぀-ヿ一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9'’_-]+/g) ?? []).length;
  return cjk + latin;
}

/** 커서 위치의 인라인 서식 조상을 찾는다(도구모음 활성 상태용). */
function marksAt(
  state: EditorState,
  head: number,
  to: number,
): Tab["marks"] {
  const marks = { bold: false, italic: false, strike: false, code: false, link: false };
  try {
    const pos = head !== to ? head : Math.min(head, Math.max(0, state.doc.length));
    const tree = syntaxTree(state);
    if (tree.length === 0) return marks;
    let node = tree.resolveInner(pos, -1);
    for (;;) {
      switch (node.name) {
        case "StrongEmphasis":
          marks.bold = true;
          break;
        case "Emphasis":
          marks.italic = true;
          break;
        case "Strikethrough":
          marks.strike = true;
          break;
        case "InlineCode":
          marks.code = true;
          break;
        case "Link":
        case "Image":
          marks.link = true;
          break;
        default:
          break;
      }
      if (!node.parent || node.parent.name === "Document") break;
      node = node.parent;
    }
  } catch {
    /* 트리 미완료 등 — 기본값 유지 */
  }
  return marks;
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
    autosave: false,
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
