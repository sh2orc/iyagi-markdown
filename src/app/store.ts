// 앱 상태(탭·워크스페이스·설정·세션). React는 useStore로 구독한다.
// 에디터 자체(DOM)는 React 밖의 CodeMirror가 소유하며, 스토어는 EditorState만
// 보관한다(비활성 탭 View 해제, §7).
//
// 순수 로직(의존 주입형 IO)이라 단위 테스트가 가능하다.

import { EditorState } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { formatAllTables } from "../editor/tableFormat";
import { syntaxTree } from "@codemirror/language";
import { EditorView, type ViewUpdate } from "@codemirror/view";

import type {
  DocMeta,
  BaselineSnapshot,
  BookmarkSnapshot,
  DocComment,
  CommentExpectation,
  DocStyle,
  Draft,
  DraftInfo,
  SessionTab,
  LoadedDoc,
  RecentEntry,
  RecentSnapshot,
  FavoritesSnapshot,
  SessionState,
  Settings,
  SettingsSnapshot,
  TreeNode,
  TrashDocument,
  WorkspaceScan,
  WriteExpectation,
} from "../api";
import { isWriteConflict } from "../api";
import { applyDocStyle, DEFAULT_DOC_STYLE as DEFAULT_DOC_STYLE_T } from "./docStyle";
import { dailyNoteContent, dailyNoteTitle, findDailyNote } from "./dailyNote";
import { applyPreviewConfig, createDocState, smoothScrollIntoView, switchMode, type ViewMode } from "../editor/cm";
import { previewConfigField } from "../editor/livePreview";
import { applyWriting, spellcheckComp, spellcheckExtension } from "../editor/writing";
import { applySmartPunct } from "../editor/smartPunct";
import { editableComp, setCommentsProvider } from "../editor/cm";

import { changedLines, setDelRevertHandler, setTrackProvider, shiftLineNo, shiftLineNumbers, hunksOf, revertChange, trackingChanged, type TrackHunk } from "../editor/trackChanges";
import { frontMatterLen, stripFrontMatter } from "../editor/frontmatter";
import { invalidateLinkPreviews, ttsTextOf } from "../editor/linkPreview";
import { phrases } from "./phrases";
import { buildWikiIndex } from "../editor/wiki";
import { dirname, relPath } from "../paths";
import { collectHeadings, slugifyHeading } from "../links";
import { mapPendingRange } from "../editor/asyncEdit";
import { clampSelection, NavigationHistory, type NavigationPoint } from "./navigationHistory";
import { WorkspaceHistory } from "./workspaceHistory";
import type { WorkspaceHistoryAction } from "../api";

export type DocumentLocation = { line: number } | { anchor: string } | { pos: number };
/** Window-local metadata only: discarded buffers and undo history are never retained. */
interface ClosedTab {
  path: string;
  mode: ViewMode;
  locked: boolean;
  index: number;
  selection: EditorState["selection"];
  scroll: number;
  outerScroll: number | null;
  mtime: number;
  length: number;
}
export type ConflictResolution = { status: "applied" } | { status: "changed" } | { status: "failed"; message: string };

interface ImageImportTarget {
  tab: Tab;
  view: EditorView;
  path: string | null;
  dir: string;
  doc: EditorState["doc"];
  from: number;
  to: number;
  invalid: boolean;
}

export interface Tab {
  id: string;
  path: string | null;
  /** 창·탭별 초안 정체성. 저장/이름 변경 후에도 유지하며 파일 경로와 구분한다. */
  draftKey: string | null;
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
  /** 작업 항목 진행률(없으면 null — 상태 줄 숨김). 디바운스 재계산. */
  checkbox: { done: number; total: number } | null;
  /** 이 문서를 가리키는 백링크 수(null=아직 모름/폴더 없음). */
  backlinks: number | null;
  /** 메모가 달린 줄 번호(사이드카 로드). */
  commentLines: number[];
  /** 메모 전체 목록(패널용). */
  comments: DocComment[];
  commentsLoading: boolean;
  commentsLoaded: boolean;
  commentsError: string | null;
  /** 변경 추적 베이스라인(null이면 추적 아님). */
  baselineText: string | null;
  baselineRevision: number;
  baselineLoaded: boolean;
  baselineLoading: boolean;
  baselineBusy: boolean;
  baselineError: string | null;
  /** 변경 추적 개수(상태 줄). */
  trackStats: { added: number; removed: number } | null;
  /** 책갈피 줄 번호(SQLite 사이드카 — 원문 불변). */
  bookmarks: number[];
  bookmarksText: string | null;
  bookmarksRevision: number;
  bookmarksLoading: boolean;
  bookmarksBusy: boolean;
  bookmarksError: string | null;
  /** 마지막 저장 시각(ms). */
  savedAt: number;
  /** 저장 안 됨 표시 — 입력마다 O(문서) 비교 대신 증분 유지(정확성: 길이가
   *  같을 때만 문자열 비교로 확정한다). */
  dirty: boolean;
  /** 단어 수·글자 수 — 상태 줄용. 편집 델타로 증분 갱신한다. */
  words: number;
  chars: number;
}

export interface TrackingTarget {
  id: string;
  path: string;
  doc: EditorState["doc"];
  baseline: string | null;
}

export type ExportKind = "html" | "pdf" | "docx" | "epub";

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
  workspaceLoading: boolean;
  workspaceError: string | null;
  workspaceScopeError: string | null;
  workspaceIssues: WorkspaceScan["issues"];
  workspaceTreeLoaded: boolean;
  /** Saved document content or workspace membership changed; link reads must refresh. */
  linksRevision: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
  tocOpen: boolean;
  settings: Settings;
  settingsPending: boolean;
  settingsSaving: boolean;
  settingsError: string | null;
  theme: "light" | "dark";
  searchOpen: boolean;
  exportKind: ExportKind | null;
  recent: RecentEntry[];
  recentError: string | null;
  recentLoading: boolean;
  recentBusy: boolean;
  favorites: string[];
  favoritesLoaded: boolean;
  favoritesLoading: boolean;
  favoritesBusy: boolean;
  favoritesError: string | null;
  toasts: Toast[];
  busy: string | null;
  ready: boolean;
}

/** 저장·IO 인터페이스 — 테스트에서 가짜로 바꾼다. */
export interface StoreIO {
  readDocument(path: string): Promise<LoadedDoc>;
  writeDocument(path: string, text: string, meta: DocMeta, expected: WriteExpectation): Promise<{ mtime: number; size: number }>;
  fileRename?(from: string, to: string, root: string | null): Promise<string[]>;
  trashDocument?(reviewed: TrashDocument): Promise<void>;
  scanWorkspace(root: string): Promise<WorkspaceScan>;
  saveSession(session: SessionState): Promise<void>;
  setAssetScope(path: string, recursive: boolean): Promise<void>;
  watchPaths(files: string[], dirs: string[]): Promise<void>;
  importImage?(src: string, dir: string): Promise<string>;
  saveImageBytes?(dir: string, mime: string, bytes: Uint8Array): Promise<string>;
  recordRecent?(path: string): Promise<RecentSnapshot>;
  removeRecent?(path: string): Promise<RecentSnapshot>;
  clearRecent?(): Promise<RecentSnapshot>;
  getSession?(): Promise<SessionState | null>;
  draftSave?(draft: Draft): Promise<void>;
  draftLoad?(key: string): Promise<Draft | null>;
  draftClear?(key: string): Promise<void>;
  draftList?(): Promise<DraftInfo[]>;
  snapshotBackup?(path: string, text: string): Promise<void>;
  docStyleGet?(path: string): Promise<string | null>;
  docStyleSet?(path: string, styleJson: string): Promise<void>;
  getRecent?(): Promise<RecentSnapshot>;
  getFavorites?(): Promise<FavoritesSnapshot>;
  getWorkspaceHistory?(): Promise<RecentSnapshot>;
  updateWorkspaceHistory?(action: WorkspaceHistoryAction): Promise<RecentSnapshot>;
  setFavorite?(path: string, present: boolean): Promise<FavoritesSnapshot>;
  moveFavorite?(path: string, direction: "up" | "down", expectedRevision: number): Promise<FavoritesSnapshot>;
  bookmarkList?(path: string): Promise<BookmarkSnapshot>;
  bookmarkSet?(path: string, lineNo: number, present: boolean, expectedText: string): Promise<BookmarkSnapshot>;
  bookmarkReplace?(path: string, text: string, lines: number[], expected: Pick<BookmarkSnapshot, "text" | "lines">): Promise<BookmarkSnapshot>;
  patchSettings?(patch: Partial<Settings>): Promise<SettingsSnapshot>;
  backlinks?(root: string, path: string): Promise<unknown[]>;
  commentList?(path: string): Promise<DocComment[]>;
  commentAdd?(path: string, lineNo: number, text: string): Promise<number>;
  commentUpdate?(path: string, id: number, text: string, expected: CommentExpectation): Promise<void>;
  commentResolve?(path: string, id: number, resolved: boolean, expected: CommentExpectation): Promise<void>;
  commentRemove?(path: string, id: number, expected: CommentExpectation): Promise<void>;
  commentReanchor?(path: string, updates: Array<[number, number]>): Promise<void>;
  baselineGet?(path: string): Promise<BaselineSnapshot>;
  baselineWrite?(path: string, text: string | null, expected: { text: string | null }): Promise<BaselineSnapshot>;
  speakStart?(text: string, rate: number, voice: string): Promise<boolean>;
  speakStop?(): Promise<void>;
  speakStatus?(): Promise<boolean>;
}

/** 이중 문구 헬퍼(스토어 내 간단 토스트) — ko/en. */
function t0(ko: string, en: string): string {
  return (typeof navigator !== "undefined" && /^ko/i.test(navigator.language ?? "") ) ? ko : en;
}

let nextTabId = 1;

/** 파일 경로와 독립적인 탭 정체성 — 창 사이에서도 겹치지 않고 재시작에 유지한다. */
let nextUntitledSeq = 0;
function nextDraftKey(prefix = "untitled"): string {
  nextUntitledSeq += 1;
  const unique = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${nextUntitledSeq}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${unique}`;
}
let nextToastId = 1;

export class AppStore {
  /** 참조 보기로 고정한 탭 id — App이 세션 복원 때 지정. */
  public pinnedTabId: string | null = null;
  /** 세션 복원 중의 참조 보기 경로 — 탭이 열리면 App이 resolve. */
  public pendingPinnedPath: string | null = null;
  /** 사이드바에서 접어 둔 폴더 경로(세션 저장·복원, Sidebar가 사용). */
  public collapsedFolders: Set<string> = new Set();
  /** 목차 패널에서 접어 둔 제목 슬러그(세션 저장·복원). */
  public tocCollapsed: Set<string> = new Set();
  /** 읽기 전용 잠금 탭(실수 편집 방지 — 모드와 독립). */
  public lockedTabIds: Set<string> = new Set();
  /** 세션 복원 중 잠금 경로 — 탭 열림 후 App이 해소. */
  public pendingLockedPaths: Set<string> = new Set();
  /** 분할 편집 — 두 번째 뷰와 그 탭 id(RefPane 편집 모드). */
  public splitView: EditorView | null = null;
  public splitTabId: string | null = null;
  /** 진행 중인 openPath(같은 경로 동시 열기 → 탭 중복 방지). */
  private pendingOpens = new Map<string, Promise<Tab | null>>();
  private trashingPaths = new Set<string>();
  private navigationRevision = 0;
  private scrollRevision = 0;
  private navigationHistory = new NavigationHistory();
  private closedTabs: ClosedTab[] = [];
  private reopeningTab = false;
  private imageImports = new Map<string, ImageImportTarget>();
  state: AppStoreState = {
    tabs: [],
    activeId: null,
    workspace: null,
    tree: [],
    workspaceLoading: false,
    workspaceError: null,
    workspaceScopeError: null,
    workspaceIssues: [],
    workspaceTreeLoaded: false,
    linksRevision: 0,
    sidebarOpen: true,
    sidebarWidth: 240,
    tocOpen: defaultSessionToc(),
    settings: defaultSettings(),
    settingsPending: false,
    settingsSaving: false,
    settingsError: null,
    theme: "light",
    searchOpen: false,
    exportKind: null,
    recent: [],
    recentError: null,
    recentLoading: false,
    recentBusy: false,
    favorites: [],
    favoritesLoaded: false,
    favoritesLoading: false,
    favoritesBusy: false,
    favoritesError: null,
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
  private confirmedSettings = defaultSettings();
  private settingsRevision = -1;
  private pendingSettings: Partial<Settings> = {};
  private settingsEdits = new Map<keyof Settings, number>();
  private settingsEditSequence = 0;
  private settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private settingsWrite: Promise<void> | null = null;

  /** 경로별 마지막 자기 쓰기 내용 — 쓰기 시작 시점(동기)에 기록.
   *  fs 이벤트가 저장 응답보다 먼저 도착하는 경합에서 savedText는 아직 예전
   *  내용이라 내용 비교가 뚫린다 — 디스크가 "방금 쓰기 시작한 내용"과 같아도
   *  자기 저장이다. */
  private recentSelfWrites = new Map<string, { id: string; text: string; at: number }>();

  /** 30초 지난 자기 쓰기 기록 정리(메모리 상한 — 부하 시 이벤트 지연 실측 ~2s의 15배). */
  private pruneSelfWrites(): void {
    const cutoff = Date.now() - 30_000;
    for (const [p, e] of this.recentSelfWrites) {
      if (e.at < cutoff) this.recentSelfWrites.delete(p);
    }
  }

  /** 자동 저장 실패 알림 중복 억제 — 성공으로 회복되면 해제(다음 실패 재알림). */
  private autosaveFailNotified = false;

  constructor(io: StoreIO) {
    this.workspaceHistory = new WorkspaceHistory(io);
    setCommentsProvider(() => this.active?.comments ?? []);
    // 변경 추적 — 활성 탭의 베이스라인 제공(장식 플러그인이 소비).
    // 삭제 블록 클릭 → 그 변경 되돌리기(베이스라인 텍스트 재삽입).
    setDelRevertHandler((view, doc, baseline, hunk, tabId) => {
      this.revertTrackingHunk(view, doc, baseline, hunk, tabId);
    });
    setTrackProvider((view: unknown) => {
      // 분할 편집 뷰면 그 탭의 추적을 보여준다(활성 탭이 아님).
      const tab =
        this.splitView !== null && view === this.splitView
          ? (this.state.tabs.find((t) => t.id === this.splitTabId) ?? null)
          : this.active;
      return tab ? { id: tab.id, baseline: tab.baselineText } : null;
    });
    this.io = io;
  }
  readonly workspaceHistory: WorkspaceHistory;

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

  /** Reserve this file action's navigation intent ahead of older pending reads. */
  beginWorkspaceFileAction(): { root: string | null; isWorkspaceCurrent: () => boolean; canNavigate: () => boolean } {
    this.syncActiveState();
    const root = this.state.workspace, workspaceVersion = this.workspaceVersion;
    const navigationRevision = ++this.navigationRevision, tab = this.active;
    const doc = tab?.state.doc, selection = tab?.state.selection, path = tab?.path;
    const split = this.splitView, splitDoc = split?.state.doc, splitSelection = split?.state.selection;
    const isWorkspaceCurrent = () => this.state.workspace === root && this.workspaceVersion === workspaceVersion;
    return { root, isWorkspaceCurrent, canNavigate: () => isWorkspaceCurrent() &&
      this.navigationRevision === navigationRevision && this.active === tab && tab?.path === path &&
      tab?.state.doc === doc && (!selection || !!tab?.state.selection.eq(selection)) &&
      this.splitView === split && split?.state.doc === splitDoc && (!splitSelection || !!split?.state.selection.eq(splitSelection)) };
  }

  async openPath(path: string, mode?: ViewMode, location?: DocumentLocation, isCurrent: () => boolean = () => true): Promise<void> {
    await this.openPathForNavigation(path, mode, location, isCurrent);
  }

  private async openPathForNavigation(path: string, mode?: ViewMode, location?: DocumentLocation,
    isCurrent: () => boolean = () => true, restore?: ClosedTab): Promise<Tab | null> {
    if (!isCurrent() || this.trashingPaths.has(path)) return null;
    const revision = ++this.navigationRevision;
    const existing = this.state.tabs.find((t) => t.path === path);
    if (existing) {
      const changedTab = this.active !== existing;
      this.activate(existing.id);
      if (location && this.active === existing) this.revealLocation(location, !changedTab);
      void this.recordRecent(path);
      return existing;
    }
    // 진행 중 열기 재사용 — 기존 확인(동기)과 탭 추가(await 뒤) 사이에 같은
    // 경로가 다시 들어오면(더블클릭·두 번 Enter) 같은 파일 탭이 2개 생긴다.
    let pending = this.pendingOpens.get(path);
    if (!pending) {
      pending = this.openPathInner(path, mode);
      this.pendingOpens.set(path, pending);
    }
    try {
      const tab = await pending;
      // Reads may finish out of order. Keep the loaded tab, but only the latest
      // navigation may select it or move the cursor.
      if (tab && isCurrent() && revision === this.navigationRevision && this.state.tabs.includes(tab) && tab.path === path) {
        this.activate(tab.id);
        if (location && this.active === tab) this.revealLocation(location, false);
        if (restore && this.active === tab) this.restoreClosedTab(tab, restore);
      }
      return tab && this.state.tabs.includes(tab) && tab.path === path ? tab : null;
    } finally {
      if (this.pendingOpens.get(path) === pending) this.pendingOpens.delete(path);
    }
  }

  get canReopenClosedTab(): boolean { return this.closedTabs.length > 0 && !this.reopeningTab; }

  async reopenClosedTab(): Promise<void> {
    const target = this.closedTabs.at(-1);
    if (!target || this.reopeningTab) return;
    this.syncActiveState();
    const origin = this.active, view = this.view;
    const originState = view?.state ?? origin?.state;
    const split = this.splitView, splitState = split?.state;
    const current = () => {
      const state = this.view?.state ?? this.active?.state;
      return this.active === origin && this.view === view && state?.doc === originState?.doc &&
        (!originState || !!state?.selection.eq(originState.selection)) &&
        this.splitView === split && split?.state.doc === splitState?.doc &&
        (!splitState || !!split?.state.selection.eq(splitState.selection));
    };
    this.reopeningTab = true;
    this.emit();
    try {
      const tab = await this.openPathForNavigation(target.path, target.mode, undefined, current, target);
      // Remove only this entry: another tab may have been closed during the read.
      // Failed reads keep the entry available for retry (e.g. disconnected drives).
      if (tab) this.closedTabs = this.closedTabs.filter((entry) => entry !== target);
    } finally {
      this.reopeningTab = false;
      this.emit();
    }
  }

  private restoreClosedTab(tab: Tab, target: ClosedTab): void {
    const index = this.state.tabs.indexOf(tab);
    this.state.tabs.splice(index, 1);
    this.state.tabs.splice(Math.min(target.index, this.state.tabs.length), 0, tab);
    const selection = clampSelection(target.selection, tab.state.doc.length);
    // Pixel offsets are only useful if the saved file still has the same stamp/size.
    const sameFile = tab.savedMtime === target.mtime && tab.state.doc.length === target.length;
    if (this.view) {
      ++this.scrollRevision;
      this.view.dispatch({ selection, scrollIntoView: !sameFile });
      if (sameFile) this.restoreScroll(target.scroll, target.outerScroll);
    } else tab.state = tab.state.update({ selection }).state;
    tab.scroll = sameFile ? target.scroll : 0;
    if (target.locked) this.setLocked(tab.id, true);
    this.emit();
    this.scheduleSessionSave();
  }

  /** Move in the active document. Exact IDs take priority over literal wiki titles. */
  revealLocation(location: DocumentLocation, recordHistory = true): void {
    ++this.navigationRevision;
    const view = this.view;
    if (!view || !this.active) return;
    let pos: number | undefined;
    if ("pos" in location) {
      if (!Number.isFinite(location.pos)) return;
      pos = Math.max(0, Math.min(Math.trunc(location.pos), view.state.doc.length));
    } else if ("line" in location) {
      if (!Number.isFinite(location.line)) return;
      pos = view.state.doc.line(Math.max(1, Math.min(Math.trunc(location.line), view.state.doc.lines))).from;
    } else if (location.anchor === "") {
      pos = 0;
    } else {
      const headings = collectHeadings(view.state.doc.toString());
      const titleSlug = slugifyHeading(location.anchor);
      const heading = headings.find((h) => h.slug === location.anchor) ??
        headings.find((h) => h.text === location.anchor || h.slug === titleSlug);
      pos = heading?.pos;
    }
    if (pos === undefined) {
      this.toast(t0("링크의 제목을 찾지 못했습니다", "The linked heading was not found"), "info");
      return;
    }
    // Do not let activate()'s delayed scroll restoration undo this destination.
    ++this.scrollRevision;
    if (recordHistory && (view.state.selection.ranges.length > 1 || view.state.selection.main.head !== pos || !view.state.selection.main.empty)) {
      this.navigationHistory.visit(this.captureNavigation());
    }
    smoothScrollIntoView(view, pos);
    this.emit();
  }

  get canNavigateBack(): boolean { return this.navigationHistory.canBack; }
  get canNavigateForward(): boolean { return this.navigationHistory.canForward; }

  private captureNavigation(): NavigationPoint | null {
    const tab = this.active;
    if (!tab) return null;
    const outer = this.view?.scrollDOM.closest(".editor-area.read-mode");
    return { tabId: tab.id, selection: (this.view?.state ?? tab.state).selection,
      scroll: this.view?.scrollDOM.scrollTop ?? tab.scroll,
      outerScroll: typeof HTMLElement !== "undefined" && outer instanceof HTMLElement ? outer.scrollTop : null };
  }

  navigateHistory(forward = false): void {
    // A history action also supersedes a file read still awaiting completion.
    ++this.navigationRevision;
    const target = this.navigationHistory.travel(forward, this.captureNavigation());
    if (!target) return;
    const tab = this.state.tabs.find((item) => item.id === target.tabId);
    if (!tab) return;
    this.activate(tab.id, false);
    const view = this.view;
    const selection = clampSelection(target.selection, (view?.state ?? tab.state).doc.length);
    ++this.scrollRevision;
    if (view) {
      view.dispatch({ selection, scrollIntoView: target.scroll === null });
      if (target.scroll !== null) this.restoreScroll(target.scroll, target.outerScroll);
      view.focus();
    } else tab.state = tab.state.update({ selection }).state;
    this.emit();
    this.scheduleSessionSave();
  }

  private async openPathInner(path: string, mode?: ViewMode): Promise<Tab | null> {
    let doc: LoadedDoc;
    try {
      doc = await this.io.readDocument(path);
    } catch (e) {
      this.toast(`${t0("문서를 열지 못했습니다", "Could not open document")}: ${e instanceof Error ? e.message : String(e)}`, "error");
      return null;
    }
    void this.recordRecent(path);
    // §7: 임계(1MB) 초과 문서는 장식 비용이 커진다 — 소스 모드로 열고 알린다.
    const LARGE_DOC = 1_000_000;
    const forced = doc.text.length > LARGE_DOC && !mode ? ("source" as const) : null;
    const tabMode: ViewMode = mode ?? forced ?? this.state.settings.defaultMode;
    const tab: Tab = {
      id: `t${nextTabId++}`,
      path,
      draftKey: nextDraftKey("document"),
      title: baseName(path),
      state: createDocState(doc.text, tabMode),
      mode: tabMode,
      savedText: doc.text,
      meta: doc.meta,
      savedMtime: doc.mtime,
      savedAt: doc.mtime * 1000,
      scroll: 0,
      cursorLine: 1,
      cursorCol: 1,
      conflict: null,
      docStyle: null,
      marks: { bold: false, italic: false, strike: false, code: false, link: false },
      selChars: 0,
      checkbox: checkboxOf(doc.text),
      backlinks: null,
      bookmarks: [], bookmarksText: null, bookmarksRevision: -1, bookmarksLoading: false, bookmarksBusy: false, bookmarksError: null,
      commentLines: [],
      comments: [], commentsLoading: false, commentsLoaded: false, commentsError: null,
      baselineText: null, baselineRevision: -1, baselineLoaded: false, baselineLoading: false, baselineBusy: false, baselineError: null,
      trackStats: null,
      dirty: false,
      // 통계는 본문만(프론트매터는 메타 — Obsidian 방식).
      words: countWords(stripFrontMatter(doc.text)),
      chars: stripFrontMatter(doc.text).length,
    };
    this.state.tabs.push(tab);
    void this.loadTabMetadata(tab);
    if (forced) {
      this.toast(this.phrases?.bigDocSource ?? "Large document — opened in source mode for responsiveness.", "info");
    }
    this.emit();
    void this.syncWatch();
    this.scheduleSessionSave();
    return tab;
  }

  private metadataLoads = new Map<string, Promise<void>>();
  private styleReadFailureNotified = false;

  /** 열기와 복원에서 동일한 문서 부가 정보를 읽는다. 늦은 응답은 새 편집을 덮지 않는다. */
  private loadTabMetadata(tab: Tab): Promise<void> {
    const operation = this.readTabMetadata(tab);
    this.metadataLoads.set(tab.id, operation);
    const cleanup = () => {
      if (this.metadataLoads.get(tab.id) === operation) this.metadataLoads.delete(tab.id);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private async readTabMetadata(tab: Tab): Promise<void> {
    const path = tab.path;
    const key = path ?? tab.draftKey;
    if (!key) return;
    const originalStyle = tab.docStyle;
    const [style] = await Promise.allSettled([
      this.io.docStyleGet?.(key), path ? this.refreshBookmarks(path) : undefined,
      path ? this.refreshComments(path) : undefined, path ? this.refreshBaseline(path) : undefined,
    ]);
    if ((tab.path ?? tab.draftKey) !== key || !this.state.tabs.includes(tab)) return;
    if (style.status === "rejected" && !this.styleReadFailureNotified) {
      this.styleReadFailureNotified = true;
      this.toast(`${t0("문서 스타일을 불러오지 못했습니다", "Could not load document style")}: ${String(style.reason)}`, "error");
    } else if (style.status === "fulfilled" && this.io.docStyleGet) {
      this.styleReadFailureNotified = false;
    }
    if (style.status === "fulfilled" && style.value && tab.docStyle === originalStyle) {
      try { tab.docStyle = { ...DEFAULT_DOC_STYLE_T, ...JSON.parse(style.value) }; } catch { /* 원문은 유지 */ }
    }
    if (this.active === tab) this.applyConfig();
    this.emit();
  }

  /** 지정 내용으로 새 탭(템플릿) — 원문은 그 내용이 곧 원문이 된다. */
  newTabWithContent(content: string): void {
    const tabMode = this.state.settings.defaultMode;
    const tab: Tab = {
      id: `t${nextTabId++}`,
      path: null,
      draftKey: nextDraftKey(),
      title: "",
      state: createDocState(content, tabMode),
      mode: tabMode,
      savedText: "",
      meta: { hadBom: false, crlf: false },
      savedMtime: 0,
      savedAt: 0,
      scroll: 0,
      cursorLine: 1,
      cursorCol: 1,
      conflict: null,
      docStyle: null,
      marks: { bold: false, italic: false, strike: false, code: false, link: false },
      selChars: 0,
      bookmarks: [], bookmarksText: null, bookmarksRevision: -1, bookmarksLoading: false, bookmarksBusy: false, bookmarksError: null,
      commentLines: [],
      comments: [], commentsLoading: false, commentsLoaded: false, commentsError: null,
      baselineText: null, baselineRevision: -1, baselineLoaded: false, baselineLoading: false, baselineBusy: false, baselineError: null,
      trackStats: null,
      dirty: content.length > 0,
      words: countWords(stripFrontMatter(content)),
      chars: stripFrontMatter(content).length,
      checkbox: checkboxOf(content),
      backlinks: 0,
    };
    this.state.tabs.push(tab);
    this.activate(tab.id);
    this.emit();
    this.scheduleSessionSave();
    if (tab.dirty) void this.saveDraftOf(tab.id);
  }

  /** 데일리 노트 — 오늘(로컬 날짜) 문서를 열거나 없으면 만든다. 시작 내용은
   *  제목 하나뿐(템플릿 문법 없음 — 사용자가 이어 쓴다). 워크스페이스 필요. */
  async openDailyNote(now = new Date()): Promise<void> {
    const root = this.state.workspace;
    if (!root) {
      this.toast(t0("먼저 폴더를 열어 주세요", "Open a folder first"), "error");
      return;
    }
    const title = dailyNoteTitle(now);
    const path = findDailyNote(this.state.tree, title)
      ?? `${root.replace(/\/+$/, "")}/${title}.md`;
    try {
      await this.io.readDocument(path); // 있으면 그대로 연다.
    } catch {
      // 없으면 시작 내용으로 생성 — kind:"missing"은 이미 있으면 거부한다.
      try {
        await this.io.writeDocument(path, dailyNoteContent(title), { hadBom: false, crlf: false },
          { kind: "missing" });
      } catch {
        // 생성 경합(다른 창이 먼저 만듦) 등 — 열기로 진행.
      }
    }
    await this.refreshTree();
    await this.openPath(path);
  }

  newTab(): void {
    const tab: Tab = {
      id: `t${nextTabId++}`,
      path: null,
      draftKey: nextDraftKey(),
      title: "",
      state: createDocState("", this.state.settings.defaultMode),
      mode: this.state.settings.defaultMode,
      savedText: "",
      meta: { hadBom: false, crlf: false },
      savedMtime: 0,
      savedAt: 0,
      scroll: 0,
      cursorLine: 1,
      cursorCol: 1,
      conflict: null,
      docStyle: null,
      marks: { bold: false, italic: false, strike: false, code: false, link: false },
      selChars: 0,
      checkbox: null,
      backlinks: null,
      bookmarks: [], bookmarksText: null, bookmarksRevision: -1, bookmarksLoading: false, bookmarksBusy: false, bookmarksError: null,
      commentLines: [],
      comments: [], commentsLoading: false, commentsLoaded: false, commentsError: null,
      baselineText: null, baselineRevision: -1, baselineLoaded: false, baselineLoading: false, baselineBusy: false, baselineError: null,
      trackStats: null,
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
  activate(id: string, recordHistory = true): void {
    ++this.navigationRevision;
    if (!this.state.tabs.some((tab) => tab.id === id)) return;
    const prev = this.active;
    if (recordHistory && !this.restoring && prev?.id !== id) this.navigationHistory.visit(this.captureNavigation());
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
      this.scheduleBacklinks();
      if (!tab.commentsLoading) void this.refreshComments();
      if (!tab.baselineLoading) void this.refreshBaseline();
      if (!tab.bookmarksLoading) void this.refreshBookmarks();
    }
    this.emit();
    this.scheduleSessionSave();
  }

  /** setState 직후 스크롤 복원 — 큰 문서는 높이 추정이 갱신되기 전이라
   *  scrollTop이 잘릴 수 있다. 즉시 한 번, 측정 마친 뒤 한 번 더 맞춘다. */
  private restoreScroll(top: number, outerTop: number | null = null): void {
    const revision = ++this.scrollRevision;
    const view = this.view;
    if (!view) return;
    const tabId = this.state.activeId;
    // React may not have switched the area's mode class yet after activation.
    const outer = view.scrollDOM.closest(".editor-area");
    if (outerTop !== null && outer instanceof HTMLElement) outer.scrollTop = outerTop;
    view.scrollDOM.scrollTop = top;
    view.requestMeasure({
      read: () => null,
      write: () => {
        const v = this.view;
        if (v !== view || revision !== this.scrollRevision || this.state.activeId !== tabId) return;
        if (Math.abs(v.scrollDOM.scrollTop - top) > 1) v.scrollDOM.scrollTop = top;
        if (outerTop !== null && outer instanceof HTMLElement) outer.scrollTop = outerTop;
      },
    });
  }

  closeTab(id: string): void {
    const idx = this.state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    if (this.state.tabs[idx].path && this.trashingPaths.has(this.state.tabs[idx].path!)) return;
    // 닫힌 탭의 초안은 버린 확인을 거친 것 — 안전망도 지운다(확인 없이 닫힌
    // 무수정 탭은 초안이 없으니 no-op).
    const closing = this.state.tabs[idx];
    this.syncActiveState();
    if (closing.path) {
      const point = this.active === closing ? this.captureNavigation() : null;
      this.closedTabs = this.closedTabs.filter((entry) => entry.path !== closing.path);
      this.closedTabs.push({ path: closing.path, mode: closing.mode, locked: this.lockedTabIds.has(id), index: idx,
        selection: point?.selection ?? closing.state.selection, scroll: closing.scroll,
        outerScroll: point?.outerScroll ?? null, mtime: closing.savedMtime, length: closing.savedText.length });
      if (this.closedTabs.length > 20) this.closedTabs.shift();
    }
    this.navigationHistory.remove(id);
    this.stopDocumentTimer(this.autosaveTimers, id);
    this.invalidateDraftReconciliation(id);
    this.stopDocumentTimer(this.checkboxTimers, id);
    this.stopDocumentTimer(this.trackTimers, id);
    const closingKey = closing.draftKey ?? closing.path;
    if (closingKey) void this.clearDraft(closingKey);
    this.stopDocStyleTimer(id);
    if (this.pendingDocStyles.has(id)) void this.queueDocumentOp(id, () => this.persistDocStyle(id));
    this.state.tabs.splice(idx, 1);
    this.draftReconcileVersions.delete(id);
    this.draftCleanupRetries.delete(id);
    this.lockedTabIds.delete(id);
    this.bookmarkRetries.delete(id);
    if (closing.path && !this.state.tabs.some((tab) => tab.path === closing.path)) {
      this.bookmarkWriteErrors.delete(closing.path);
      this.bookmarkAnchorErrors.delete(closing.path);
    }
    this.diskReadVersions.delete(id);
    this.overwriteApprovals.delete(id);
    if (closingKey) this.unavailableSessionTabs.delete(closingKey);
    if (this.state.activeId === id) {
      ++this.navigationRevision;
      ++this.scrollRevision;
      const next = this.state.tabs[Math.min(idx, this.state.tabs.length - 1)];
      this.state.activeId = next?.id ?? null;
      const tab = this.active;
      if (tab && this.view) {
        this.view.setState(tab.state);
        this.restoreScroll(tab.scroll);
        this.applyConfig();
      }
      this.navigationHistory.discardCurrent(this.captureNavigation());
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

  /** Capture before a picker/IO wait; sequential copies become one undoable edit. */
  async importImages(view: EditorView | null, source: string[] | Blob | null | (() => Promise<string | null>)): Promise<void> {
    const tab = view === this.view ? this.active : view === this.splitView
      ? this.state.tabs.find((item) => item.id === this.splitTabId) : null;
    const dir = tab?.path ? dirname(tab.path) : this.state.workspace;
    if (!view || !tab || !dir) {
      this.toast(t0("이미지를 넣을 문서와 저장 폴더를 먼저 여세요", "Open a document and a destination folder before inserting images"), "error");
      return;
    }
    if (view.state.readOnly || this.lockedTabIds.has(tab.id) || this.discardingTabIds.has(tab.id)) {
      this.toast(t0("읽기 전용 문서에는 이미지를 넣을 수 없습니다", "Cannot insert images into a read-only document"), "error");
      return;
    }
    if (this.imageImports.has(tab.id)) {
      this.toast(t0("이 문서의 이미지 가져오기가 진행 중입니다", "An image import is already in progress for this document"));
      return;
    }
    if (Array.isArray(source) && source.length > 32) {
      this.toast(t0("이미지는 한 번에 32개까지 가져올 수 있습니다", "Import at most 32 images at a time"), "error");
      return;
    }
    const selection = view.state.selection.main;
    const target: ImageImportTarget = { tab, view, path: tab.path, dir, doc: view.state.doc,
      from: selection.from, to: selection.to, invalid: false };
    const valid = () => !target.invalid && view.dom.isConnected && this.state.tabs.includes(tab) &&
      (view === this.view ? this.active === tab : view === this.splitView && this.splitTabId === tab.id) &&
      tab.path === target.path && (tab.path ? dirname(tab.path) : this.state.workspace) === dir &&
      view.state.doc === target.doc && !view.state.readOnly &&
      !this.lockedTabIds.has(tab.id) && !this.discardingTabIds.has(tab.id);
    this.imageImports.set(tab.id, target);
    const copied: string[] = [];
    const failures: string[] = [];
    try {
      let files: string[] | Blob | null;
      if (typeof source === "function") {
        const selected = await source();
        if (!selected) return;
        files = [selected];
      } else files = Array.isArray(source) ? [...source] : source;
      if (!valid()) {
        this.toast(t0("문서나 삽입 위치가 바뀌어 이미지 가져오기를 중단했습니다", "Image import stopped because the document or insertion range changed"));
        return;
      }
      if (!Array.isArray(files)) {
        if (!files) throw new Error("The clipboard event did not contain readable image data");
        if (!this.io.saveImageBytes) throw new Error("Clipboard image import is unavailable");
        if (!files.size || files.size > 32 * 1024 * 1024) throw new Error("Image must contain between 1 byte and 32 MiB");
        const bytes = new Uint8Array(await files.arrayBuffer());
        if (!valid()) {
          this.toast(t0("문서나 삽입 위치가 바뀌어 이미지 가져오기를 중단했습니다", "Image import stopped because the document or insertion range changed"));
          return;
        }
        copied.push(await this.io.saveImageBytes(dir, files.type, bytes));
      } else {
        if (!this.io.importImage) throw new Error("Image import is unavailable");
        for (const file of files) {
          if (!valid()) break;
          try { copied.push(await this.io.importImage(file, dir)); }
          catch (error) { failures.push(`${file}: ${String(error)}`); }
        }
      }
      if (copied.length && valid()) {
        // Encode filename delimiters as well as spaces; each line is a separate image.
        const insert = copied.map((path) => {
          const href = relPath(dir, path).split("/").map((part) =>
            encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
          return `![](${href})\n`;
        }).join("");
        const sel = view.state.selection.main;
        const stillSelected = sel.from === target.from && sel.to === target.to;
        view.dispatch({
          changes: { from: target.from, to: target.to, insert },
          ...(stillSelected ? { selection: { anchor: target.from + 2 } } : {}),
          annotations: isolateHistory.of("full"), userEvent: "input.insertImage",
        });
      } else if (copied.length) {
        this.toast(`${t0("문서가 바뀌어 이미지를 삽입하지 않았습니다. 복사된 파일", "The document changed; images were not inserted. Copied files")}: ${copied.slice(0, 3).join(", ")}${copied.length > 3 ? ` (+${copied.length - 3})` : ""}`, "info");
      } else if (!valid()) {
        this.toast(t0("문서나 삽입 위치가 바뀌어 이미지 가져오기를 중단했습니다", "Image import stopped because the document or insertion range changed"));
      }
      if (failures.length) {
        this.toast(`${t0("일부 이미지를 가져오지 못했습니다", "Some images could not be imported")} (${failures.length}): ${failures.slice(0, 3).join("; ")}`, "error");
      }
    } catch (error) {
      this.toast(`${t0("이미지를 가져오지 못했습니다", "Could not import image")}: ${String(error)}`, "error");
    } finally {
      if (this.imageImports.get(tab.id) === target) this.imageImports.delete(tab.id);
    }
  }

  private mapImageImport(tab: Tab, update: ViewUpdate): void {
    const target = this.imageImports.get(tab.id);
    if (!target || target.invalid || !update.docChanged) return;
    if (target.view !== update.view || target.doc !== update.startState.doc) { target.invalid = true; return; }
    mapPendingRange(target, update.changes);
    target.doc = update.state.doc;
  }

  // — 모드 —

  setMode(mode: ViewMode): void {
    const tab = this.active;
    if (!tab) return;
    tab.mode = mode;
    if (this.view) {
      switchMode(this.view, mode);
      // 잠긴 탭은 모드 전환 후에도 읽기 전용 유지(편집 모드로 돌아와도).
      if (mode !== "read" && this.lockedTabIds.has(tab.id)) {
        this.view.dispatch({
          effects: editableComp.reconfigure([
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ]),
        });
      }
    }
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
    if (!Number.isInteger(from) || !Number.isInteger(to) || from === to ||
        from < 0 || to < 0 || from >= this.state.tabs.length || to >= this.state.tabs.length) return;
    const tabs = [...this.state.tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    this.state.tabs = tabs;
    this.emit();
    this.scheduleSessionSave();
  }

  // — 문서 변경 반영(CodeMirror 리스너에서) —

  onDocChanged(update: ViewUpdate): void {
    // 분할 편집 판 — 두 번째 뷰의 편집은 그 뷰의 탭에 반영(활성 탭이 아님).
    const inSplit = this.splitView !== null && update.view === this.splitView && update.view !== this.view;
    const view = inSplit ? this.splitView! : this.view;
    const tab = inSplit
      ? (this.state.tabs.find((t) => t.id === this.splitTabId) ?? null)
      : this.active;
    if (!tab || !view) return;
    this.mapImageImport(tab, update);
    if (update.docChanged) this.navigationHistory.map(tab.id, update.changes);
    tab.state = view.state;
    const sel = view.state.selection.main;
    const line = view.state.doc.lineAt(sel.head);
    tab.cursorLine = line.number;
    tab.cursorCol = sel.head - line.from + 1;
    tab.marks = marksAt(view.state, sel.head, sel.to);
    // 선택 통계(Word 상태 표시줄) — 증분 카운터 재사용.
    tab.selChars = sel.empty ? 0 : view.state.sliceDoc(sel.from, sel.to).length;
    if (update.docChanged) {
      // 통계는 편집 델타로 증분 갱신 — 키 입력마다 문서 전체를 훑지 않는다.
      const prevDoc = update.startState.doc;
      const fmLen = frontMatterLen(prevDoc.toString());
      let touchedFm = false;
      let firstA = Infinity;
      let lastA = -1;
      let charDelta = 0;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (fromA < fmLen) {
          // 프론트매터 영역(닫는 --- 포함 경계)의 편집 — 통계에 넣지 않는다.
          touchedFm = true;
          return;
        }
        firstA = Math.min(firstA, fromA);
        lastA = Math.max(lastA, toA);
        const removed = toA > fromA ? prevDoc.sliceString(fromA, toA) : "";
        charDelta += inserted.length - removed.length;
      });
      if (!touchedFm && lastA >= 0) {
        // 단어 수는 영역 기반 정확 증분: 변경 범위를 감싼 단어 경계 구간의
        // 앞뒤 단어 수 차이. 문자 수는 산술적으로 정확. (경계를 가로지르는
        // 편집에서 words-removed 근사가 어긋나던 버그 수정 — 여러 변경의
        // 사이 변하지 않는 구간은 양쪽에 같이 세려 상쇄된다.)
        const doc = view.state.doc;
        const startA = expandWordStart(prevDoc, firstA);
        const endA = expandWordEnd(prevDoc, lastA);
        // 결합 방향이 핵심: 시작은 삽입 **앞**(포함), 끝은 **뒤** — 확장이
        // 경계 없이 변경점과 겹쳐도 삽입된 텍스트가 구역 안에 들어온다.
        const startB = update.changes.mapPos(startA, -1);
        const endB = update.changes.mapPos(endA, 1);
        const wPrev = countWords(prevDoc.sliceString(startA, endA));
        const wNew = countWords(doc.sliceString(startB, endB));
        tab.words += wNew - wPrev;
        tab.chars += charDelta;
      }
      if (touchedFm) {
        // 프론트매터 편집 중에만 전체 재계산(O(문서)지만 드문 경로 — 본문
        // 타이핑은 여전히 증분만).
        const body = stripFrontMatter(view.state.doc.toString());
        tab.words = countWords(body);
        tab.chars = body.length;
      }
      // 충돌·교체 승인은 명시적 저장이 필요하다. 그 외에는 길이가 같을 때만
      // 문자열을 비교해 되돌리기로 원문에 복귀했는지 확인한다.
      const doc = view.state.doc;
      if (tab.conflict !== null || this.overwriteApprovals.has(tab.id) || doc.length !== tab.savedText.length) tab.dirty = true;
      else tab.dirty = doc.toString() !== tab.savedText;
    }
    // 작업 항목 진행률 — O(문서) 스캔이라 입력이 멈춘 뒤에만(300ms 디바운스).
    if (update.docChanged) {
      this.stopDocumentTimer(this.checkboxTimers, tab.id);
      const tabId = tab.id;
      this.checkboxTimers.set(tabId, setTimeout(() => {
        this.checkboxTimers.delete(tabId);
        const t2 = this.state.tabs.find((x) => x.id === tabId);
        if (t2) {
          t2.checkbox = checkboxOf(t2.state.doc.toString());
          const targetView = t2 === this.active ? this.view
            : this.splitTabId === tabId ? this.splitView : null;
          if (t2.bookmarks.length && targetView) {
            const config = targetView.state.field(previewConfigField, false);
            const bookmarks = this.bookmarkLinesFor(t2);
            if (config && (config.bookmarks.length !== bookmarks.length || bookmarks.some((line, i) => line !== config.bookmarks[i]))) {
              applyPreviewConfig(targetView, { ...config, bookmarks });
            }
          }
          this.emit();
        }
      }, 300));
    }
    if (update.docChanged) {
      // 각 탭의 입력만 해당 탭의 디바운스를 갱신한다. 커서 이동은 저장을 미루지 않는다.
      this.scheduleAutosave(tab);
      this.scheduleDraftReconciliation(tab.id);
    }
    // 변경 추적 개수 — diff라 입력이 멈춘 뒤에만(300ms).
    if (update.docChanged && tab.baselineText != null) {
      this.stopDocumentTimer(this.trackTimers, tab.id);
      const tid = tab.id;
      this.trackTimers.set(tid, setTimeout(() => {
        this.trackTimers.delete(tid);
        const t = this.state.tabs.find((x) => x.id === tid);
        if (!t || t.baselineText == null) return;
        const r = changedLines(t.baselineText, t.state.doc.toString());
        t.trackStats = { added: r.added.size, removed: r.removed };
        this.scheduleEmit();
      }, 300));
    }
    // 상태 줄(줄/칸·더티 점) 갱신 — rAF로 모아 프레임당 한 번 렌더한다.
    this.scheduleEmit();
  }

  private baselineReads = new Map<string, number>();
  private baselineReadSequence = 0;
  private baselineWrites = new Set<string>();

  private applyBaseline(path: string, snapshot: BaselineSnapshot): void {
    for (const tab of this.state.tabs) {
      if (tab.path !== path || snapshot.revision < tab.baselineRevision) continue;
      tab.baselineText = snapshot.text;
      tab.baselineRevision = snapshot.revision;
      tab.baselineLoaded = true;
      tab.baselineError = null;
      const diff = snapshot.text === null ? null : changedLines(snapshot.text, tab.state.doc.toString());
      tab.trackStats = diff ? { added: diff.added.size, removed: diff.removed } : null;
    }
    if (this.active?.path === path) this.view?.dispatch({ effects: trackingChanged.of(undefined) });
    if (this.state.tabs.find((tab) => tab.id === this.splitTabId)?.path === path) {
      this.splitView?.dispatch({ effects: trackingChanged.of(undefined) });
    }
    this.emit();
  }

  async refreshBaseline(path: string | null = this.active?.path ?? null): Promise<void> {
    if (!path) return;
    const targets = this.state.tabs.filter((tab) => tab.path === path);
    if (!targets.length) return;
    const version = ++this.baselineReadSequence;
    this.baselineReads.set(path, version);
    for (const tab of targets) tab.baselineLoading = true;
    this.emit();
    try {
      if (!this.io.baselineGet) throw new Error(t0("변경 추적 저장소를 사용할 수 없습니다", "Tracking storage is unavailable"));
      const snapshot = await this.io.baselineGet(path);
      if (this.baselineReads.get(path) === version) this.applyBaseline(path, snapshot);
    } catch (error) {
      if (this.baselineReads.get(path) !== version) return;
      for (const tab of targets) {
        if (tab.path === path && this.state.tabs.includes(tab)) tab.baselineError = String(error);
      }
    } finally {
      if (this.baselineReads.get(path) === version) {
        this.baselineReads.delete(path);
        for (const tab of targets) if (tab.path === path) tab.baselineLoading = false;
        this.emit();
      }
    }
  }

  trackingTarget(): TrackingTarget | null {
    this.syncActiveState();
    const tab = this.active;
    return tab?.path ? { id: tab.id, path: tab.path, doc: tab.state.doc, baseline: tab.baselineText } : null;
  }

  startTracking(target = this.trackingTarget()): Promise<boolean> { return this.changeTracking("start", target); }
  acceptAllChanges(target = this.trackingTarget()): Promise<boolean> { return this.changeTracking("accept", target); }
  stopTracking(target = this.trackingTarget()): Promise<boolean> { return this.changeTracking("stop", target); }

  private async changeTracking(action: "start" | "accept" | "stop", target: TrackingTarget | null): Promise<boolean> {
    if (!target) { this.toast(t0("먼저 문서를 저장하세요", "Save the document first"), "error"); return false; }
    if (this.baselineWrites.has(target.path)) return false;
    this.baselineWrites.add(target.path);
    for (const tab of this.state.tabs) if (tab.path === target.path) tab.baselineBusy = true;
    this.emit();
    try {
      return await this.queueDocumentOp(target.id, async () => {
        const tab = this.state.tabs.find((item) => item.id === target.id && item.path === target.path);
        this.syncActiveState();
        const valid = () => !!tab && this.state.tabs.includes(tab) && tab.path === target.path &&
          tab.state.doc === target.doc && tab.baselineText === target.baseline && tab.baselineLoaded &&
          !this.discardingTabIds.has(target.id);
        if (!valid() || (action === "start" ? target.baseline !== null : target.baseline === null)) {
          throw new Error(t0("문서나 추적 기준이 바뀌었습니다. 변경 내용을 다시 확인하세요.",
            "The document or tracking baseline changed. Review tracked changes again."));
        }
        if (!this.io.baselineWrite) throw new Error(t0("변경 추적 저장소를 사용할 수 없습니다", "Tracking storage is unavailable"));
        if (target.baseline !== null) {
          if (!this.io.snapshotBackup) throw new Error(t0("기준 내용 백업을 사용할 수 없습니다", "Tracking baseline backup is unavailable"));
          await this.io.snapshotBackup(target.path, target.baseline);
          if (!valid()) throw new Error(t0("백업 중 문서가 바뀌었습니다. 다시 확인하세요.", "The document changed during backup. Review it again."));
        }
        // 보낸 시점의 본문만 기준으로 삼는다. 저장 중 추가 입력은 새 변경으로 남는다.
        const text = action === "stop" ? null : target.doc.toString();
        const snapshot = await this.io.baselineWrite(target.path, text, { text: target.baseline });
        this.syncActiveState();
        this.applyBaseline(target.path, snapshot);
        this.toast(action === "start" ? t0("변경 추적을 시작했습니다", "Tracking started") :
          action === "accept" ? t0("변경을 모두 수락했습니다", "All changes accepted") : t0("변경 추적을 중지했습니다", "Tracking stopped"));
        return true;
      });
    } catch (error) {
      // 저장 실패 시 화면의 기준을 지우지 않는다. 최신 기준은 명시적 재조회로 확인한다.
      for (const tab of this.state.tabs) if (tab.path === target.path) tab.baselineError = String(error);
      this.toast(`${t0("변경 추적을 저장하지 못했습니다", "Could not save tracking state")}: ${String(error)}`, "error");
      return false;
    } finally {
      this.baselineWrites.delete(target.path);
      for (const tab of this.state.tabs) if (tab.path === target.path) tab.baselineBusy = false;
      this.emit();
    }
  }

  /** 패널과 본문 위젯이 공유하는 실행 취소 가능한 편집. */
  revertTrackingHunk(view: EditorView, doc: EditorState["doc"], baseline: string, hunk: TrackHunk, expectedTabId: string): boolean {
    const tab = view === this.view ? this.active : view === this.splitView
      ? this.state.tabs.find((item) => item.id === this.splitTabId) : null;
    if (!tab || tab.id !== expectedTabId || tab.baselineText !== baseline || view.state.doc !== doc || view.state.readOnly ||
      this.lockedTabIds.has(tab.id) || this.discardingTabIds.has(tab.id) || tab.baselineBusy) return false;
    const change = revertChange(hunk, (line) => doc.line(line), doc.lines);
    if (!change) return false;
    view.dispatch({ changes: change, annotations: isolateHistory.of("full"), userEvent: "input.revertTrackHunk" });
    return true;
  }

  /** 다음/이전 변경으로 점프(Word 검토 '다음 변경'). */
  nextChange(forward: boolean): void {
    const tab = this.active;
    const view = this.view;
    if (!tab || tab.baselineText == null || !view) return;
    const hunks = hunksOf(tab.baselineText, view.state.doc.toString());
    if (hunks.length === 0) {
      this.toast(t0("변경이 없습니다", "No changes"));
      return;
    }
    const cur = view.state.selection.main.head;
    const curLine = view.state.doc.lineAt(cur).number;
    // 커서 줄 기준 다음(또는 이전) 덩어리 — 순환(마지막 뒤는 처음).
    const target = forward
      ? (hunks.find((h: { line: number }) => h.line > curLine)?.line ?? hunks[0]!.line)
      : ([...hunks].reverse().find((h: { line: number }) => h.line < curLine)?.line ?? hunks[hunks.length - 1]!.line);
    const line = view.state.doc.line(Math.min(Math.max(target, 1), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
  }

  /** 같은 탭의 저장·이름 변경은 요청 순서대로 실행한다. */
  private documentOps = new Map<string, Promise<boolean>>();
  private writingPaths = new Map<string, string>();
  private discardingTabIds = new Set<string>();
  private overwriteApprovals = new Map<string, { path: string; expected: WriteExpectation }>();

  private queueDocumentOp(id: string, run: () => Promise<boolean>): Promise<boolean> {
    const previous = this.documentOps.get(id);
    const operation = previous ? previous.then(run, run) : run();
    this.documentOps.set(id, operation);
    void operation.then(() => {
      if (this.documentOps.get(id) === operation) this.documentOps.delete(id);
    }, () => {
      if (this.documentOps.get(id) === operation) this.documentOps.delete(id);
    });
    return operation;
  }

  /** 자동 저장은 충돌 문서를 덮어쓰지 않는다. 수동 저장과 같은 경로를 사용한다. */
  saveTabById(id: string): Promise<boolean> {
    return this.queueDocumentOp(id, () => this.writeTab(id, undefined, true));
  }

  /** 복원 전 버퍼를 필수 백업하고, 검토한 탭·본문이 여전히 같을 때만 적용한다. */
  restoreVersion(id: string, path: string, expectedDoc: EditorState["doc"], text: string): Promise<boolean> {
    return this.queueDocumentOp(id, async () => {
      const tab = this.state.tabs.find((item) => item.id === id);
      const view = this.view;
      const valid = () => tab !== undefined && this.state.tabs.includes(tab) &&
        this.active === tab && tab.path === path && this.view === view &&
        view !== null && view.state.doc === expectedDoc && tab.state.doc === expectedDoc &&
        !this.lockedTabIds.has(id) && !this.discardingTabIds.has(id) && !this.trashingPaths.has(path);
      if (!valid() || !tab || !view) {
        throw new Error(t0("문서가 바뀌었거나 잠겨 있습니다. 복원할 문서를 다시 확인해 주세요.",
          "The document changed or is locked. Review the target again."));
      }
      if (expectedDoc.toString() === text) return true;
      if (!this.io.snapshotBackup) {
        throw new Error(t0("복원 전 백업을 사용할 수 없습니다.", "Backup before restore is unavailable."));
      }
      await this.io.snapshotBackup(path, expectedDoc.toString());
      // 백업을 기다리는 동안 탭 전환·이름 변경·입력·외부 다시 읽기가 일어날 수 있다.
      if (!valid()) {
        throw new Error(t0("백업 중 문서가 바뀌었습니다. 현재 내용을 확인한 뒤 다시 복원해 주세요.",
          "The document changed while backing up. Review it before restoring again."));
      }
      // 이전 입력과 합쳐지지 않는 한 번의 실행 취소 단위. 저장은 기존 자동 저장 설정을 따른다.
      view.dispatch({
        changes: { from: 0, to: expectedDoc.length, insert: text },
        selection: { anchor: 0 },
        annotations: isolateHistory.of("full"),
        userEvent: "input.restore",
      });
      return true;
    });
  }

  private async writeTab(id: string, saveAsPath?: string, automatic = false, isCurrent: () => boolean = () => true): Promise<boolean> {
    const tab = this.state.tabs.find((t) => t.id === id);
    if (!tab || !isCurrent()) return false;
    // 다른 이름으로 저장할 때 늦게 도착한 원본 스타일을 빠뜨리지 않는다.
    if (saveAsPath && saveAsPath !== tab.path) {
      await this.metadataLoads.get(id);
      if (!this.state.tabs.includes(tab)) return false;
    }
    this.syncActiveState();
    if (this.splitView && this.splitTabId === id) tab.state = this.splitView.state;
    // Save As may have waited for another write or metadata loading. Recheck the
    // caller's reviewed document before formatting or writing any contents.
    if (!isCurrent()) return false;
    const path = saveAsPath ?? tab.path;
    const approval = this.overwriteApprovals.get(id);
    if (!path || this.trashingPaths.has(path) || (tab.path !== null && this.trashingPaths.has(tab.path)) || this.discardingTabIds.has(id)
      || (automatic && (!this.state.settings.autosave || !tab.dirty || tab.conflict !== null || approval !== undefined))) return false;
    if ((path !== tab.path && this.state.tabs.some((other) => other.id !== id && other.path === path))
      || (this.writingPaths.has(path) && this.writingPaths.get(path) !== id)) {
      this.toast(t0("이미 다른 탭에서 열린 파일입니다", "This file is already open in another tab"), "error");
      return false;
    }
    // 무수정 건너뛰기는 dirty 플래그만 믿지 않고 원문과도 확정한다 — 뷰
    // 업데이트 파이프라인 밖에서 state가 교체되면 플래그가 늦을 수 있고,
    // 그 차이가 저장 누락(침묵 손실)이 되면 안 된다.
    if (!tab.dirty && path === tab.path && tab.conflict === null && tab.state.doc.toString() === tab.savedText) {
      const styleSaved = await this.persistDocStyle(id);
      if (this.bookmarkAnchorErrors.has(path)) await this.reanchorBookmarks(tab, path, tab.savedText);
      return styleSaved;
    }
    const draftKey = tab.draftKey ?? (tab.draftKey = nextDraftKey("document"));
    let newText = tab.state.doc.toString();
    const oldText = tab.savedText;
    if (this.state.settings.autoFormatTables) {
      const fmt = formatAllTables(newText);
      if (fmt !== newText) {
        const liveView = tab.id === this.state.activeId ? this.view
          : this.splitTabId === id ? this.splitView : null;
        if (liveView) {
          liveView.dispatch({ changes: { from: 0, to: liveView.state.doc.length, insert: fmt } });
          tab.state = liveView.state;
        } else {
          this.navigationHistory.invalidate(tab.id, fmt.length);
          tab.state = tab.state.update({ changes: { from: 0, to: tab.state.doc.length, insert: fmt } }).state;
        }
        newText = fmt;
      }
    }
    this.nextDiskRead(id);
    this.writingPaths.set(path, id);
    try {
      this.pruneSelfWrites();
      this.recentSelfWrites.set(path, { id, text: newText, at: Date.now() });
      const expected: WriteExpectation = path !== tab.path
        ? { kind: "overwrite" } // 다른 이름으로 저장 대화상자가 대상 교체를 확인한다.
        : approval?.path === path ? approval.expected
        : { kind: "match", text: tab.savedText, meta: tab.meta };
      const res = await this.io.writeDocument(path, newText, tab.meta, expected);
      const pathChanged = tab.path !== path;
      if (!automatic) void this.recordRecent(path);
      this.overwriteApprovals.delete(id);
      // 저장 요청 이후 입력된 내용은 아직 디스크에 없다. 기준만 저장한 버전으로
      // 옮기고 현재 버퍼와 다시 비교한다(저장 중 탭 전환도 동일).
      if (tab.path !== path && tab.docStyle) {
        this.pendingDocStyles.set(id, { tab, json: JSON.stringify(tab.docStyle) });
      }
      tab.path = path;
      tab.title = baseName(path);
      tab.savedText = newText;
      tab.savedMtime = res.mtime;
      tab.savedAt = Date.now();
      this.syncActiveState();
      if (this.splitView && this.splitTabId === id) tab.state = this.splitView.state;
      tab.dirty = tab.state.doc.toString() !== newText;
      tab.conflict = null;
      this.autosaveFailNotified = false;
      // 쓰기를 기다리는 동안 입력한 내용도 자동 저장 대상이다.
      if (tab.dirty) this.scheduleAutosave(tab);
      invalidateLinkPreviews(path);
      this.documentLinksChanged(path);
      if (pathChanged) void this.refreshTree();
      this.emit();
      void this.syncWatch();
      this.applyConfig();
      this.scheduleSessionSave();

      // 본문 저장과 별개로 스타일 쓰기 실패는 재시도 가능하게 남긴다.
      const styleSaved = await this.persistDocStyle(id);
      // 부가 정보 실패를 본문 저장 실패로 보고하지 않는다. 초안 작업도 키별로
      // 직렬화해 늦게 도착한 삭제가 더 최신 초안을 지우지 못하게 한다.
      if (tab.dirty) await this.saveDraftOf(id);
      else await this.clearDraft(draftKey);
      if (oldText !== newText) {
        try {
          const updates = tab.comments.map((c) => [c.id, Math.max(1, shiftLineNo(c.lineNo, oldText, newText))] as [number, number]);
          if (updates.length && this.io.commentReanchor) {
            await this.io.commentReanchor(path, updates);
            const lines = new Map(updates);
            tab.comments = tab.comments.map((c) => ({ ...c, lineNo: lines.get(c.id) ?? c.lineNo }));
            tab.commentLines = tab.comments.filter((c) => !c.resolved).map((c) => c.lineNo);
          }
          this.applyConfig();
          this.emit();
        } catch (e) {
          this.toast(`${t0("문서는 저장됐지만 메모 위치를 저장하지 못했습니다", "Document saved, but comment positions could not be saved")}: ${String(e)}`, "error");
        }
      }
      await this.reanchorBookmarks(tab, path, newText);
      return styleSaved;
    } catch (e) {
      this.recentSelfWrites.delete(path);
      if (isWriteConflict(e) && tab.path === path) {
        this.overwriteApprovals.delete(id);
        tab.conflict = e.code === "removed" ? "removed" : "conflict";
        tab.dirty = true;
        this.emit();
        await this.saveDraftOf(id);
      }
      if (!automatic || !this.autosaveFailNotified) {
        this.autosaveFailNotified = true;
        const message = typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e);
        this.toast(`${phrases.saveFailed}: ${message}`, "error");
      }
      return false;
    } finally {
      if (this.writingPaths.get(path) === id) this.writingPaths.delete(path);
    }
  }

  private checkboxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private trackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private draftReconcileVersions = new Map<string, number>();
  private draftCleanupRetries = new Set<string>();

  private stopDocumentTimer(timers: Map<string, ReturnType<typeof setTimeout>>, id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
  }

  private scheduleAutosave(tab: Tab): void {
    this.stopDocumentTimer(this.autosaveTimers, tab.id);
    if (!this.state.tabs.includes(tab) || !this.state.settings.autosave || !tab.path || !tab.dirty) return;
    this.autosaveTimers.set(tab.id, setTimeout(() => {
      this.autosaveTimers.delete(tab.id);
      const current = this.state.tabs.find((item) => item.id === tab.id);
      if (this.state.settings.autosave && current?.path && current.dirty) void this.saveTabById(current.id);
    }, 1500));
  }

  private scheduleDraftReconciliation(id: string): void {
    this.stopDocumentTimer(this.draftTimers, id);
    this.draftTimers.set(id, setTimeout(() => {
      this.draftTimers.delete(id);
      void this.reconcileDraft(id);
    }, 1500));
  }

  private invalidateDraftReconciliation(id: string): void {
    this.stopDocumentTimer(this.draftTimers, id);
    this.draftReconcileVersions.set(id, (this.draftReconcileVersions.get(id) ?? 0) + 1);
  }

  /** 현재 버퍼에 맞게 초안을 갱신하거나, 되돌린 파일의 낡은 초안을 지운다. */
  private async reconcileDraft(id: string, strict = false): Promise<void> {
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab || this.discardingTabIds.has(id)) return;
    const version = this.draftReconcileVersions.get(id) ?? 0;
    const current = () => this.state.tabs.includes(tab) && !this.discardingTabIds.has(id) &&
      (this.draftReconcileVersions.get(id) ?? 0) === version;
    // 저장 중 원래 내용으로 되돌렸다면 디스크가 곧 달라질 수 있다. 우선 현재
    // 버퍼를 보관하고 쓰기가 끝난 뒤 최신 상태로 다시 판단한다.
    while (!tab.dirty && tab.path && tab.conflict === null && !this.overwriteApprovals.has(id)) {
      const pending = this.documentOps.get(id);
      if (!pending) break;
      await this.saveDraftOf(id, true, strict);
      if (!current()) return;
      await pending.catch(() => {});
      if (!current()) return;
      if (this.documentOps.get(id) === pending) break;
    }
    if (tab.dirty || !tab.path || tab.conflict !== null || this.overwriteApprovals.has(id)) {
      // 빈 제목 없는 문서도 스타일과 함께 복구할 수 있어야 한다.
      await this.saveDraftOf(id, true, strict);
    } else if (tab.draftKey) {
      const key = tab.draftKey;
      let cleared = false;
      try {
        await this.queueDraft(key, async () => {
          await this.io.draftClear?.(key);
          cleared = true;
        }, strict);
      } finally {
        if (current()) {
          if (cleared) this.draftCleanupRetries.delete(id);
          else this.draftCleanupRetries.add(id);
        }
      }
    }
  }

  /** 탭 하나의 초안을 지금 임시저장(drafts.db). 무수정이면 건너뛴다. */
  private async saveDraftOf(id: string, includeClean = false, strict = false, duringDiscard = false): Promise<void> {
    const tab = this.state.tabs.find((t) => t.id === id);
    if (!tab || (!tab.dirty && !includeClean) || !duringDiscard && this.discardingTabIds.has(id)) return;
    const key = tab.draftKey ?? (tab.draftKey = nextDraftKey(tab.path ? "document" : "untitled"));
    if (this.view && tab.id === this.state.activeId) {
      tab.state = this.view.state;
      tab.scroll = this.view.scrollDOM.scrollTop;
    }
    const draft = {
        key,
        path: tab.path,
        content: tab.state.doc.toString(),
        cursor: tab.state.selection.main.head,
        scroll: tab.scroll,
        updatedAt: Date.now(),
        // 이미 확인된 외부 충돌은 재시작 뒤에도 명시적으로 확인해야 한다.
        baseText: tab.conflict ? null : tab.savedText,
        meta: tab.meta,
    };
    await this.queueDraft(key, () => this.io.draftSave?.(draft), strict);
  }

  private draftOps = new Map<string, Promise<void>>();
  private draftFailNotified = false;

  private queueDraft(key: string, run: () => Promise<void> | undefined, strict = false): Promise<void> {
    const previous = this.draftOps.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(run).then(() => {
      this.draftFailNotified = false;
    }, (e: unknown) => {
      if (strict) throw e;
      if (!this.draftFailNotified) {
        this.draftFailNotified = true;
        this.toast(`${t0("복구 초안을 저장하지 못했습니다. 문서를 저장해 주세요", "Recovery draft could not be saved. Please save your document")}: ${String(e)}`, "error");
      }
    });
    this.draftOps.set(key, operation);
    const cleanup = () => {
      if (this.draftOps.get(key) === operation) this.draftOps.delete(key);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private clearDraft(key: string, strict = false): Promise<void> {
    return this.queueDraft(key, () => this.io.draftClear?.(key), strict);
  }

  /** 모든 미저장 탭의 초안을 즉시 기록(종료 직전 호출 — 디바운스 창 회수). */
  async flushDrafts(): Promise<void> {
    // 먼저 진행 중인 작업을 끝내 실패한 초안 삭제도 재시도 대상에 포함한다.
    await Promise.all(this.draftOps.values());
    const pending = new Set(this.draftTimers.keys());
    for (const id of pending) this.stopDocumentTimer(this.draftTimers, id);
    for (const tab of this.state.tabs) if (tab.dirty) pending.add(tab.id);
    for (const id of this.draftCleanupRetries) pending.add(id);
    await Promise.all(
      [...pending].map((id) => this.reconcileDraft(id, true)),
    );
    await Promise.all(this.draftOps.values());
    if (!(await this.flushDocStyles())) {
      throw new Error(t0("문서 스타일을 저장하지 못했습니다", "Document style could not be saved"));
    }
  }

  /** 닫기 확인 전에 이미 시작된 저장·이름 변경을 끝낸다. */
  async settleDocumentWrites(): Promise<void> {
    for (;;) {
      for (const id of this.autosaveTimers.keys()) this.stopDocumentTimer(this.autosaveTimers, id);
      if (this.documentOps.size === 0) break;
      await Promise.all(this.documentOps.values());
    }
    await this.recentOps;
  }

  /** 닫기·종료가 취소되면 중단한 자동 저장을 다시 예약한다. */
  resumeAutosaves(): void {
    for (const tab of this.state.tabs) if (tab.dirty) this.scheduleAutosave(tab);
  }

  /** 다른 창에서 앱 종료를 취소하면 버림을 선택했던 버퍼도 다시 복구 가능하게 한다. */
  restoreDiscardedDocuments(ids: readonly string[]): void {
    for (const tab of this.state.tabs) {
      if (!ids.includes(tab.id)) continue;
      tab.dirty = true;
      void this.saveDraftOf(tab.id);
    }
    this.emit();
  }

  /** 확인한 문서의 복구 초안도 버린다. 종료 직전 flush가 되살리지 않게 한다. */
  async discardDocuments(ids: string[], isCurrent: () => boolean = () => true): Promise<void> {
    this.syncActiveState();
    const tabs = this.state.tabs.filter((tab) => ids.includes(tab.id));
    if (tabs.some((tab) => this.discardingTabIds.has(tab.id) || (tab.path !== null && this.trashingPaths.has(tab.path)))) {
      throw new Error(t0("이미 문서 닫기를 처리하고 있습니다", "Document closing is already in progress"));
    }
    const docOf = (tab: Tab) => this.active === tab && this.view ? this.view.state.doc
      : this.splitTabId === tab.id && this.splitView ? this.splitView.state.doc : tab.state.doc;
    const snapshots = tabs.map((tab) => ({ tab, doc: docOf(tab), path: tab.path, key: tab.draftKey ?? tab.path }));
    const current = () => isCurrent() && snapshots.every(({ tab, doc, path, key }) =>
      this.state.tabs.includes(tab) && docOf(tab) === doc && tab.path === path && (tab.draftKey ?? tab.path) === key);
    const assertCurrent = () => {
      if (!current()) throw new Error(t0("문서가 바뀌었습니다. 버릴 내용을 다시 확인해 주세요.",
        "The documents changed. Review the changes before discarding."));
    };
    assertCurrent();
    for (const tab of tabs) {
      this.discardingTabIds.add(tab.id);
      this.invalidateDraftReconciliation(tab.id);
      this.stopDocumentTimer(this.autosaveTimers, tab.id);
    }
    let discarded = false;
    try {
      for (const { tab, key } of snapshots) {
        const pending = this.documentOps.get(tab.id);
        if (pending) await pending;
        assertCurrent();
        if (key) {
          // Include a rejected clear: a provider may have deleted before failing.
          await this.clearDraft(key, true);
        }
        assertCurrent();
      }
      // 일부 초안 삭제가 실패했다면 어느 탭도 '버림 완료'로 표시하지 않는다.
      for (const tab of tabs) {
        tab.dirty = false;
        this.draftCleanupRetries.delete(tab.id);
      }
      discarded = true;
      this.emit();
    } catch (error) {
      // Keep the discard lock until compensation finishes as well.
      for (const tab of tabs) if (this.state.tabs.includes(tab) && tab.dirty) {
        try { await this.saveDraftOf(tab.id, false, true, true); }
        catch (recoveryError) { this.toast(String(recoveryError), "error"); }
      }
      throw error;
    } finally {
      for (const tab of tabs) {
        this.discardingTabIds.delete(tab.id);
        if (!discarded && this.state.tabs.includes(tab)) this.scheduleAutosave(tab);
      }
    }
  }

  // — 저장 —

  saveActive(saveAsPath?: string): Promise<boolean> {
    const id = this.active?.id;
    return id ? this.saveDocument(id, saveAsPath) : Promise.resolve(false);
  }

  /** 비활성 탭도 활성 탭을 바꾸지 않고 명시적으로 저장한다. */
  saveDocument(id: string, saveAsPath?: string, isCurrent: () => boolean = () => true): Promise<boolean> {
    return this.queueDocumentOp(id, () => this.writeTab(id, saveAsPath, false, isCurrent));
  }

  /** 탭을 닫거나 EditorState를 재생성하지 않고 경로만 바꾼다. */
  renameDocument(from: string, to: string, root: string | null = this.state.workspace): Promise<boolean> {
    if (this.trashingPaths.has(from) || this.trashingPaths.has(to)) return Promise.resolve(false);
    const tab = this.state.tabs.find((t) => t.path === from);
    if (this.state.tabs.filter((candidate) => candidate.path === from).length > 1) {
      this.toast(t0("같은 파일의 복구 탭을 정리한 뒤 이름을 변경해 주세요", "Close the other recovery tabs for this file before renaming it"), "error");
      return Promise.resolve(false);
    }
    return this.queueDocumentOp(tab?.id ?? from, async () => {
      if (this.trashingPaths.has(from) || this.trashingPaths.has(to)) return false;
      if (!this.io.fileRename) return false;
      if (tab && tab.path !== from) return false;
      if (this.state.tabs.some((t) => t.path === to && t !== tab) || this.writingPaths.has(to)) return false;
      try {
        if (tab) {
          await this.metadataLoads.get(tab.id);
          if (!(await this.persistDocStyle(tab.id))) return false;
        }
        const warnings = await this.io.fileRename(from, to, root);
        void this.loadFavorites();
        if (tab) {
          tab.path = to;
          tab.title = baseName(to);
          this.overwriteApprovals.delete(tab.id);
          // 감시기가 이름 변경 중 표시한 옛 경로의 제거 경고만 해제한다.
          if (tab.conflict === "removed") tab.conflict = null;
          // 이름 변경을 기다리는 동안 추가한 스타일은 새 경로로 저장한다.
          await this.persistDocStyle(tab.id);
        }
        void this.loadRecent();
        invalidateLinkPreviews(from);
        invalidateLinkPreviews(to);
        this.applyConfig();
        this.emit();
        this.scheduleSessionSave();
        void this.syncWatch();
        await this.refreshTree();
        if (tab?.dirty) await this.saveDraftOf(tab.id);
        // 실패한 이관의 원래 초안은 복구용으로 남긴다.
        for (const warning of warnings) this.toast(warning, "error");
        return true;
      } catch (e) {
        this.toast(e instanceof Error ? e.message : String(e), "error");
        return false;
      }
    });
  }

  /** Preserve every open buffer before moving only the reviewed disk file to Trash. */
  async trashDocument(reviewed: TrashDocument, isCurrent: () => boolean = () => true): Promise<void> {
    const { path, root } = reviewed;
    const workspaceVersion = this.workspaceVersion;
    const current = () => isCurrent() && this.state.workspace === root && this.workspaceVersion === workspaceVersion;
    if (!current() || this.trashingPaths.has(path) || this.writingPaths.has(path)) throw { code: "changed" };
    if (!this.io.trashDocument) throw { code: "unavailable" };
    this.trashingPaths.add(path);
    try {
      // Include a read that began before the dialog opened, and settle saves or
      // renames before preserving the final buffers. New writes are held above.
      await this.pendingOpens.get(path);
      const tabs = this.state.tabs.filter((tab) => tab.path === path);
      await Promise.all([this.documentOps.get(path), ...tabs.map((tab) => this.documentOps.get(tab.id))]);
      this.syncActiveState();
      if (this.splitView && tabs.some((tab) => tab.id === this.splitTabId)) {
        tabs.find((tab) => tab.id === this.splitTabId)!.state = this.splitView.state;
      }
      const snapshots = tabs.map((tab) => ({ tab, doc: tab.state.doc }));
      const unchanged = () => current() && this.state.tabs.filter((tab) => tab.path === path).length === tabs.length &&
        snapshots.every(({ tab, doc }) => this.state.tabs.includes(tab) && tab.path === path && tab.state.doc === doc &&
          !this.discardingTabIds.has(tab.id) &&
          (this.active !== tab || !this.view || this.view.state.doc === doc) &&
          (this.splitTabId !== tab.id || !this.splitView || this.splitView.state.doc === doc));
      if (!unchanged()) throw { code: "changed" };
      if (tabs.length && !this.io.draftSave) throw { code: "recoveryUnavailable" };
      for (const tab of tabs) {
        await this.saveDraftOf(tab.id, true, true);
        if (!unchanged()) throw { code: "changed" };
      }
      if (!unchanged()) throw { code: "changed" };
      await this.io.trashDocument(reviewed);
      // Deletion succeeded even if subsequent refresh fails. Keep tabs and all
      // edits, and suppress automatic recreation via the removed-file conflict.
      this.documentLinksChanged(path);
      invalidateLinkPreviews(path);
      for (const tab of this.state.tabs.filter((tab) => tab.path === path)) this.externalChangeOf(tab, path, "removed");
      this.scheduleSessionSave();
      if (this.state.workspace === root && this.workspaceVersion === workspaceVersion) {
        try { await this.refreshTree(); } catch (error) { this.toast(String(error), "error"); }
      }
    } finally { this.trashingPaths.delete(path); }
  }

  // — 외부 변경 —

  private diskReadVersions = new Map<string, number>();

  private nextDiskRead(id: string): number {
    const version = (this.diskReadVersions.get(id) ?? 0) + 1;
    this.diskReadVersions.set(id, version);
    return version;
  }

  externalChange(path: string, kind: "changed" | "removed"): void {
    this.documentLinksChanged(path);
    const tabs = this.state.tabs.filter((t) => t.path === path);
    if (!tabs.length) {
      // 폴더 자체의 삭제·재스캔 이벤트도 열린 하위 문서에 적용한다.
      const prefix = `${path.replace(/\/+$/, "")}/`;
      for (const childPath of new Set(this.state.tabs.map((tab) => tab.path))) {
        if (childPath?.startsWith(prefix)) this.externalChange(childPath, kind);
      }
      // 트리 구조가 바뀌는 이벤트(삭제)만 재스캔 — 내용 변경(changed)은
      // 트리와 무관하므로 부가 조회(검색·백링크)만 갱신한다(성능 최적화).
      if (kind === "removed") void this.refreshTree();
      return;
    }
    for (const tab of tabs) this.externalChangeOf(tab, path, kind);
  }

  private externalChangeOf(tab: Tab, path: string, kind: "changed" | "removed"): void {
    this.syncActiveState();
    const version = this.nextDiskRead(tab.id);
    if (kind === "removed") {
      tab.conflict = "removed";
      tab.dirty = true;
      // The open buffer may now be the only remaining copy of a clean document.
      void this.saveDraftOf(tab.id);
      this.emit();
      return;
    }
    // 내용 비교로 자기 저장 판별 — 시간 창(부하 시 fs 이벤트가 1.5~2초 늦게
    // 오면 뚫린다)·비활성 탭 저장도 커버. 파일이 마지막 저장 내용 또는 최근
    // 자기 쓰기 내용(await 전 기록 — 저장 응답보다 이벤트가 먼저 오는 경합)과
    // 같으면 외부 변경이 아니다(직접 편집 중인데 충돌 모달이 뜨는 오남용 방지).
    void (async () => {
      let sameAsSaved = false;
      try {
        const doc = await this.io.readDocument(path);
        this.pruneSelfWrites();
        const selfWrite = this.recentSelfWrites.get(path);
        const approval = this.overwriteApprovals.get(tab.id);
        const accepted = approval?.path === path && approval.expected.kind === "match"
          ? approval.expected : null;
        sameAsSaved = (doc.text === tab.savedText &&
          doc.meta.hadBom === tab.meta.hadBom && doc.meta.crlf === tab.meta.crlf) ||
          (selfWrite?.id === tab.id && doc.text === selfWrite.text) ||
          (accepted !== null && doc.text === accepted.text &&
            doc.meta.hadBom === accepted.meta.hadBom && doc.meta.crlf === accepted.meta.crlf);
      } catch {
        /* 읽기 실패 — 기존 흐름으로 판정 */
      }
      if (tab.path !== path || !this.state.tabs.includes(tab)
        || this.diskReadVersions.get(tab.id) !== version) return;
      if (sameAsSaved) {
        return;
      }
      if (tab.dirty) {
        tab.conflict = "conflict";
        this.emit();
      } else {
        // 수정 중이 아니면 자동 다시 읽기(커서·스크롤 보존).
        void this.reloadTab(tab.id, true).then((result) => {
          if (result.status === "failed") this.toast(result.message, "error");
        });
      }
      // 내용 변경(changed)은 트리 구조와 무관 — 부가 조회(검색·백링크)만
      // 갱신한다(성능 최적화, 트리 재스캔 생략).
    })();
  }

  async reloadTab(id: string, keepPosition: boolean, isCurrent: () => boolean = () => true): Promise<ConflictResolution> {
    const tab = this.state.tabs.find((t) => t.id === id);
    if (!tab?.path || this.trashingPaths.has(tab.path) || !isCurrent()) return { status: "changed" };
    this.syncActiveState();
    if (this.splitView && this.splitTabId === id) tab.state = this.splitView.state;
    const path = tab.path;
    const originalDoc = tab.state.doc;
    const version = this.nextDiskRead(id);
    const valid = () => isCurrent() && tab.path === path && this.state.tabs.includes(tab) &&
      this.diskReadVersions.get(id) === version && !this.discardingTabIds.has(id) && !this.trashingPaths.has(path);
    const sync = () => {
      this.syncActiveState();
      if (this.splitView && this.splitTabId === id) tab.state = this.splitView.state;
    };
    try {
      const pending = this.documentOps.get(id);
      if (pending) await pending;
      if (!valid()) return { status: "changed" };
      let doc = await this.io.readDocument(path);
      if (!valid()) return { status: "changed" };
      sync();
      // 명시적인 다시 읽기 이후의 입력도 보호한다. 이전 dirty 여부만으로
      // 비교하면 이미 dirty인 문서에서 추가된 입력을 잃는다.
      if (tab.state.doc !== originalDoc) {
        tab.conflict = "conflict";
        this.emit();
        return { status: "changed" };
      }
      if (tab.dirty && originalDoc.toString() !== doc.text) {
        if (!this.io.snapshotBackup) throw new Error(t0("교체 전 버전 기록을 사용할 수 없습니다", "Version backup before reload is unavailable"));
        await this.io.snapshotBackup(path, originalDoc.toString());
        if (!valid()) return { status: "changed" };
        sync();
        if (tab.state.doc !== originalDoc) return { status: "changed" };
        // Backup IO may take time. Load the disk again before replacing the buffer.
        doc = await this.io.readDocument(path);
        if (!valid()) return { status: "changed" };
        sync();
        if (tab.state.doc !== originalDoc) return { status: "changed" };
      }
      const isActive = tab.id === this.state.activeId;
      this.navigationHistory.invalidate(tab.id, doc.text.length);
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
        if (this.splitView && this.splitTabId === id) this.splitView.setState(tab.state);
      }
      tab.savedText = doc.text;
      tab.meta = doc.meta;
      tab.savedMtime = doc.mtime;
      tab.savedAt = doc.mtime * 1000;
      tab.dirty = false;
      tab.words = countWords(stripFrontMatter(doc.text));
      tab.chars = stripFrontMatter(doc.text).length;
      tab.checkbox = checkboxOf(doc.text);
      tab.conflict = null;
      this.overwriteApprovals.delete(id);
      if (tab.draftKey) void this.clearDraft(tab.draftKey);
      this.emit();
      return { status: "applied" };
    } catch (e) {
      if (!valid()) return { status: "changed" };
      if (tab.conflict === null) { tab.conflict = "conflict"; this.emit(); }
      return { status: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  async keepMine(id: string, isCurrent: () => boolean = () => true): Promise<ConflictResolution> {
    const tab = this.state.tabs.find((t) => t.id === id);
    if (!tab?.path || this.trashingPaths.has(tab.path) || tab.conflict === null || !isCurrent()) return { status: "changed" };
    this.syncActiveState();
    if (this.splitView && this.splitTabId === id) tab.state = this.splitView.state;
    const path = tab.path;
    const conflict = tab.conflict;
    const originalDoc = tab.state.doc;
    const version = this.nextDiskRead(id);
    const valid = () => isCurrent() && tab.path === path && tab.conflict === conflict &&
      tab.state.doc === originalDoc && this.state.tabs.includes(tab) &&
      this.diskReadVersions.get(id) === version && !this.discardingTabIds.has(id) && !this.trashingPaths.has(path);
    try {
      const pending = this.documentOps.get(id);
      if (pending) await pending;
      if (!valid()) return { status: "changed" };
      // 지금 디스크 버전에 대한 승인이다. 이후 다시 바뀌면 다음 저장도 충돌한다.
      const expected: WriteExpectation = conflict === "removed"
        ? { kind: "missing" }
        : await this.io.readDocument(path).then((doc) => ({
          kind: "match" as const, text: doc.text, meta: doc.meta,
        }));
      if (!valid()) return { status: "changed" };
      await this.saveDraftOf(id, true, true);
      if (!valid()) return { status: "changed" };
      this.overwriteApprovals.set(id, { path, expected });
      tab.dirty = true;
      tab.conflict = null;
      this.emit();
      return { status: "applied" };
    } catch (e) {
      return valid() ? { status: "failed", message: e instanceof Error ? e.message : String(e) } : { status: "changed" };
    }
  }

  // — 워크스페이스 —

  async openWorkspace(dir: string): Promise<void> {
    const changed = this.state.workspace !== dir;
    const version = ++this.workspaceVersion;
    this.state.workspace = dir;
    this.state.sidebarOpen = true;
    this.state.workspaceLoading = true;
    this.state.workspaceError = null;
    this.state.workspaceScopeError = null;
    if (changed) {
      this.state.tree = [];
      this.state.workspaceIssues = [];
      this.state.workspaceTreeLoaded = false;
      this.wikiIndex = new Map();
      this.invalidateBacklinks();
      this.applyConfig();
    }
    // 열기 의도는 즉시 반영한다. 느린 이전 스캔이 끝나기를 기다려 저장하지 않는다.
    this.emit();
    this.scheduleSessionSave();
    void this.io.setAssetScope(dir, true).catch((error: unknown) => {
      if (this.workspaceVersion !== version || this.state.workspace !== dir) return;
      this.state.workspaceScopeError = String(error);
      this.emit();
    });
    void this.syncWatch();
    await this.refreshTree();
    if (this.workspaceVersion === version && this.state.workspace === dir && this.state.workspaceTreeLoaded && !this.state.workspaceError) {
      void this.workspaceHistory.record(dir, () => this.workspaceVersion === version && this.state.workspace === dir);
    }
  }

  closeWorkspace(): void {
    this.workspaceVersion += 1;
    this.treeRefreshRequested = false;
    this.state.workspace = null;
    this.state.tree = [];
    this.state.workspaceLoading = false;
    this.state.workspaceError = null;
    this.state.workspaceScopeError = null;
    this.state.workspaceIssues = [];
    this.state.workspaceTreeLoaded = false;
    this.wikiIndex = new Map();
    this.invalidateBacklinks();
    this.applyConfig(); // 위키링크 전부 미해결 표시로
    this.emit();
    void this.syncWatch();
    this.scheduleSessionSave();
  }

  /** 위키링크 해석 인덱스(트리에서) — 참조 교체로 프리뷰 재계산을 유발한다. */
  wikiIndex: Map<string, string[]> = new Map();

  private treeRefreshPromise: Promise<void> | null = null;
  private treeRefreshRequested = false;
  private workspaceVersion = 0;

  refreshTree(): Promise<void> {
    this.treeRefreshRequested = true;
    if (this.treeRefreshPromise) return this.treeRefreshPromise;
    const request = Promise.resolve().then(async () => {
      while (this.treeRefreshRequested) {
        this.treeRefreshRequested = false;
        const root = this.state.workspace;
        const version = this.workspaceVersion;
        if (!root) continue;
        this.state.workspaceLoading = true;
        this.state.workspaceError = null;
        this.emit();
        try {
          const report = await this.io.scanWorkspace(root);
          if (this.state.workspace !== root || this.workspaceVersion !== version) continue;
          this.state.tree = report.tree;
          this.state.workspaceIssues = report.issues;
          this.state.workspaceTreeLoaded = true;
          this.wikiIndex = buildWikiIndex(report.tree);
          this.invalidateBacklinks();
          this.applyConfig();
          this.scheduleBacklinks();
          void this.refreshComments();
        } catch (error) {
          if (this.state.workspace === root && this.workspaceVersion === version) {
            // 같은 폴더의 마지막 결과만 유지하며, 실패를 빈 폴더로 표시하지 않는다.
            this.state.workspaceError = String(error);
          }
        } finally {
          if (this.state.workspace === root && this.workspaceVersion === version) {
            this.state.workspaceLoading = this.treeRefreshRequested;
            this.emit();
          }
        }
      }
    });
    this.treeRefreshPromise = request;
    void request.then(() => {
      this.treeRefreshPromise = null;
      if (this.treeRefreshRequested) void this.refreshTree();
    });
    return request;
  }

  private watchFailureNotified = false;
  private watchSyncPromise: Promise<void> | null = null;
  private watchSyncRequested = false;

  /** 감시 대상은 직렬로 반영한다. 중간 요청은 최신 탭·폴더 목록으로 합친다. */
  syncWatch(): Promise<void> {
    this.watchSyncRequested = true;
    if (this.watchSyncPromise) return this.watchSyncPromise;
    const request = Promise.resolve().then(async () => {
      while (this.watchSyncRequested) {
        this.watchSyncRequested = false;
        const files = this.state.tabs.map((tab) => tab.path).filter((path): path is string => !!path);
        const dirs = this.state.workspace ? [this.state.workspace] : [];
        try {
          await this.io.watchPaths(files, dirs);
          this.watchFailureNotified = false;
        } catch (e) {
          if (!this.watchFailureNotified) {
            this.watchFailureNotified = true;
            this.toast(`${t0("외부 파일 변경을 감시하지 못했습니다", "Could not watch for external file changes")}: ${String(e)}`, "error");
          }
        }
      }
    });
    this.watchSyncPromise = request;
    void request.then(() => {
      this.watchSyncPromise = null;
      if (this.watchSyncRequested) void this.syncWatch();
    });
    return request;
  }

  // — 설정·테마 —

  setSettings(settings: Settings): void {
    this.confirmedSettings = settings;
    this.applySettings();
  }

  acceptSettings(snapshot: SettingsSnapshot): void {
    if (snapshot.revision < this.settingsRevision) return;
    this.settingsRevision = snapshot.revision;
    this.setSettings(snapshot.settings);
  }

  private applySettings(): void {
    const wasAutosaving = this.state.settings.autosave;
    this.state.settings = { ...this.confirmedSettings, ...this.pendingSettings };
    if (wasAutosaving !== this.state.settings.autosave) {
      for (const tab of this.state.tabs) this.scheduleAutosave(tab);
    }
    this.state.theme = resolveTheme(this.state.settings);
    this.state.settingsPending = this.settingsEdits.size > 0;
    this.applyConfig();
    this.emit();
  }

  /** 모든 진입점이 공유하는 즉시 반영·디바운스 저장. 실패한 패치도 유지한다. */
  private patchSettings(patch: Partial<Settings>): void {
    if (!this.io.patchSettings) {
      this.setSettings({ ...this.state.settings, ...patch });
      return;
    }
    const keys = Object.keys(patch) as Array<keyof Settings>;
    if (!keys.length) return;
    this.pendingSettings = { ...this.pendingSettings, ...patch };
    for (const key of keys) this.settingsEdits.set(key, ++this.settingsEditSequence);
    this.applySettings();
    if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer);
    this.settingsSaveTimer = setTimeout(() => {
      this.settingsSaveTimer = null;
      void this.flushSettings().catch(() => { /* 오류 상태와 알림은 저장 큐가 기록한다. */ });
    }, 300);
  }

  /** 종료·재시도 시 디바운스를 기다리지 않고 남은 변경까지 직렬 저장한다. */
  flushSettings(): Promise<void> {
    if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer);
    this.settingsSaveTimer = null;
    if (this.settingsWrite) return this.settingsWrite;
    if (!this.settingsEdits.size || !this.io.patchSettings) return Promise.resolve();
    this.state.settingsSaving = true;
    this.emit();
    this.settingsWrite = (async () => {
      while (this.settingsEdits.size) {
        if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer);
        this.settingsSaveTimer = null;
        const patch = { ...this.pendingSettings };
        const edits = new Map(this.settingsEdits);
        try {
          const snapshot = await this.io.patchSettings!(patch);
          // 같은 값을 다시 선택한 경우에도 새 편집 번호가 있으면 보존한다.
          for (const [key, version] of edits) {
            if (this.settingsEdits.get(key) === version) {
              this.settingsEdits.delete(key);
              delete this.pendingSettings[key];
            }
          }
          this.state.settingsError = null;
          if (snapshot.revision >= this.settingsRevision) {
            this.settingsRevision = snapshot.revision;
            this.confirmedSettings = snapshot.settings;
          }
          // 더 최신 이벤트를 이미 받았으면 응답은 무시하되 해제된 패치는 반영한다.
          this.applySettings();
        } catch (error) {
          const message = String(error);
          if (this.state.settingsError !== message) {
            this.toast(`${phrases.settingsSaveFailed}: ${message}`, "error");
          }
          this.state.settingsError = message;
          throw error;
        }
      }
    })().finally(() => {
      this.settingsWrite = null;
      this.state.settingsSaving = false;
      this.emit();
    });
    return this.settingsWrite;
  }

  /** 설정 패치(지속) — 컴포넌트용 공개 팔레트·찾기 바 등. */
  persistSettings(patch: Partial<Settings>): void {
    this.patchSettings(patch);
  }

  toggleTypewriter(): void {
    this.patchSettings({ typewriter: !this.state.settings.typewriter });
  }

  toggleFocusMode(): void {
    this.patchSettings({ focusMode: !this.state.settings.focusMode });
  }

  /** 소스 모드 분할 미리보기 전환(왼쪽 소스·오른쪽 읽기 — 끄면 순수 소스). */
  toggleSourcePreview(): void {
    this.patchSettings({ sourcePreview: !this.state.settings.sourcePreview });
  }

  /** 서식 기호 보기(Word ¶) — 공백 ·· 탭 → 줄끝 ¶ 토글. */
  toggleFormattingMarks(): void {
    this.patchSettings({ formattingMarks: !this.state.settings.formattingMarks });
  }

  /** 소리내어 읽기 — 선택이 있으면 그 텍스트, 아니면 본문 전체(프론트매터
   *  제외). rate는 분당 단어 근사(기본 175 — say 기본값 근처). */
  speakActive(rateOverride?: number): void {
    const tab = this.active;
    if (!tab || !this.view) return;
    const sel = this.view.state.selection.main;
    // TTS는 마커를 발음하지 않게 정화(선택은 사용자가 본 그대로 — 마커도
    // 선택했다면 읽어준다). 문서 전체는 펜스 제외 + 마커 정리.
    const text = !sel.empty
      ? this.view.state.doc.sliceString(sel.from, sel.to)
      : ttsTextOf(this.view.state.doc.toString());
    if (!text.trim()) return;
    const rate = rateOverride ?? this.state.settings.ttsRate;
    const voice = this.state.settings.ttsVoice;
    void this.io.speakStart?.(text, rate, voice).then((started) => {
      if (started) {
        this.toast(sel.empty ? phrases.speakStartedDoc : phrases.speakStartedSel);
        this.markSpeaking(true);
      } else {
        // 시작 실패가 조용하면 눌렀는데 아무 일도 없는 것처럼 보인다.
        this.toast(phrases.speakFailed, "error");
      }
    });
  }

  speakStop(): void {
    void this.io.speakStop?.();
    this.markSpeaking(false);
  }

  /** 새 문서 생성(빈 파일) 후 연다 — 끊긴 링크 등에서 즉시 만들기. */
  async createNote(path: string): Promise<boolean> {
    if (this.trashingPaths.has(path)) return false;
    try {
      await this.io.writeDocument(path, "", { hadBom: false, crlf: false }, { kind: "missing" });
      void this.refreshTree();
      await this.openPath(path);
      return true;
    } catch (e) {
      this.toast(typeof e === "object" && e !== null && "message" in e ? String(e.message) : String(e), "error");
      return false;
    }
  }

  /** 읽는 중 표시 — 시작 시 켜고 2초 폴링으로 자연 종료를 감지한다. */
  speaking = false;
  private speakingTimer: ReturnType<typeof setInterval> | null = null;

  private markSpeaking(on: boolean): void {
    this.speaking = on;
    this.emit();
    if (this.speakingTimer) {
      clearInterval(this.speakingTimer);
      this.speakingTimer = null;
    }
    if (on) {
      this.speakingTimer = setInterval(() => {
        void this.io.speakStatus?.().then((still) => {
          if (!still && this.speaking) this.markSpeaking(false);
        });
      }, 2000);
    }
  }

  toggleSentenceFocus(): void {
    this.patchSettings({ focusSentence: !this.state.settings.focusSentence });
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
      bookmarks: tab ? this.bookmarkLinesFor(tab) : [],
      commentLines: tab?.commentLines ?? [],
      comments: tab?.comments ?? [],
      longSentenceMarks: this.state.settings.longSentenceMarks,
      longSentenceMin: this.state.settings.longSentenceMin,
      formattingMarks: this.state.settings.formattingMarks,
      tableWidths: tab?.docStyle?.tableWidths ?? {},
      wikiIndex: this.wikiIndex,
    });
    applySmartPunct(this.view, this.state.settings.smartPunctuation);
    applyWriting(this.view, {
      typewriter: this.state.settings.typewriter,
      focus: this.state.settings.focusMode,
      sentence: this.state.settings.focusSentence,
      active: (tab?.mode ?? this.state.settings.defaultMode) !== "read",
    });
    this.view.dispatch({
      effects: spellcheckComp.reconfigure(
        this.state.settings.spellcheck ? spellcheckExtension() : [],
      ),
    });
    this.applyDocStyleVars();
  }

  /** 문서별 스타일을 에디터 컨테이너 CSS 변수로(호스트는 App이 등록한다). */
  hostEl: HTMLElement | null = null;
  /** 백링크 수 캐시(경로→개수) — 트리가 바뀌면 다 지운다(다른 파일이 고쳐졌을 수 있음). */
  private backlinksCache = new Map<string, number>();
  private backlinksTimer: ReturnType<typeof setTimeout> | null = null;

  /** 읽기 전용 잠금 토글 — 편집 모드를 유지한 채 입력 차단(탭 단위). */
  setLocked(id: string, locked: boolean): void {
    const tab = this.state.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (locked) this.lockedTabIds.add(id);
    else this.lockedTabIds.delete(id);
    if (this.view && tab.id === this.state.activeId && tab.mode !== "read") {
      // 편집 모드에서만 재구성 — 읽기 모드는 이미 읽기 전용.
      const ro = [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ];
      const rw = [
        EditorState.readOnly.of(false),
        EditorView.editable.of(true),
      ];
      this.view.dispatch({
        effects: editableComp.reconfigure(locked ? ro : rw),
      });
    }
    this.emit();
  }

  private commentsReadSequence = 0;
  private commentsReads = new Map<string, number>();

  /** 실패는 빈 목록으로 바꾸지 않고 마지막 목록과 오류를 함께 보존한다. */
  async refreshComments(path: string | null = this.active?.path ?? null): Promise<void> {
    if (!path) return;
    const targets = this.state.tabs.filter((tab) => tab.path === path);
    if (!targets.length) return;
    const version = ++this.commentsReadSequence;
    this.commentsReads.set(path, version);
    for (const tab of targets) { tab.commentsLoading = true; tab.commentsError = null; }
    this.emit();
    try {
      if (!this.io.commentList) throw new Error(t0("메모 저장소를 사용할 수 없습니다", "Comment storage is unavailable"));
      const list = await this.io.commentList(path);
      if (this.commentsReads.get(path) !== version) return;
      for (const tab of targets) {
        if (tab.path !== path || !this.state.tabs.includes(tab)) continue;
        tab.comments = list;
        tab.commentLines = list.filter((comment) => !comment.resolved).map((comment) => comment.lineNo);
        tab.commentsLoaded = true;
      }
    } catch (error) {
      if (this.commentsReads.get(path) !== version) return;
      for (const tab of targets) {
        if (tab.path === path && this.state.tabs.includes(tab)) tab.commentsError = String(error);
      }
    } finally {
      if (this.commentsReads.get(path) === version) {
        this.commentsReads.delete(path);
        for (const tab of targets) {
          if (tab.path === path && this.state.tabs.includes(tab)) tab.commentsLoading = false;
        }
        if (this.active?.path === path) this.applyConfig();
        this.emit();
      }
    }
  }

  private async mutateComments(target: { id: string; path: string }, change: (tab: Tab) => Promise<unknown>): Promise<void> {
    await this.queueDocumentOp(target.id, async () => {
      const tab = this.state.tabs.find((item) => item.id === target.id && item.path === target.path);
      if (!tab || this.discardingTabIds.has(target.id)) {
        throw new Error(t0("문서가 닫혔거나 경로가 바뀌었습니다. 입력한 메모를 복사한 뒤 문서를 다시 여세요.",
          "The document was closed or moved. Copy your comment and reopen the document."));
      }
      // 변경 전 조회 응답은 무효화하고, 성공/실패 모두 원래 문서를 다시 조회한다.
      this.commentsReads.set(target.path, ++this.commentsReadSequence);
      try { await change(tab); }
      finally { await this.refreshComments(target.path); }
      if (tab.commentsError) this.toast(t0("메모는 저장됐지만 목록을 새로 불러오지 못했습니다. 메모 패널에서 다시 불러오세요.",
        "The comment was saved, but the list could not be refreshed. Reload it in the comments panel."), "error");
      return true;
    });
  }

  async addComment(target: { id: string; path: string }, lineNo: number, text: string, expectedDoc: EditorState["doc"]): Promise<void> {
    await this.mutateComments(target, async (tab) => {
      this.syncActiveState();
      if (tab.state.doc !== expectedDoc) {
        throw new Error(t0("메모 작성 중 문서 내용이 바뀌었습니다. 입력을 복사한 뒤 위치를 다시 선택하세요.",
          "The document changed while writing this comment. Copy your text and select the location again."));
      }
      if (!this.io.commentAdd) throw new Error(t0("메모 저장소를 사용할 수 없습니다", "Comment storage is unavailable"));
      // DB 앵커는 디스크 본문 기준이다. 다음 본문 저장 때 한 번만 이동한다.
      const savedLine = shiftLineNo(lineNo, expectedDoc.toString(), tab.savedText);
      if (savedLine < 1) throw new Error(t0("새로 입력한 줄에 메모를 남기려면 먼저 문서를 저장하세요. 입력한 메모는 복사해 둘 수 있습니다.",
        "Save the document before commenting on newly inserted text. You can copy your comment first."));
      await this.io.commentAdd(target.path, savedLine, text.trim());
    });
  }

  async editComment(target: { id: string; path: string }, comment: DocComment, text: string): Promise<void> {
    await this.mutateComments(target, async () => {
      if (!this.io.commentUpdate) throw new Error(t0("메모 저장소를 사용할 수 없습니다", "Comment storage is unavailable"));
      await this.io.commentUpdate(target.path, comment.id, text.trim(), { text: comment.text, resolved: comment.resolved });
    });
  }

  async resolveComment(target: { id: string; path: string }, comment: DocComment): Promise<void> {
    await this.mutateComments(target, async () => {
      if (!this.io.commentResolve) throw new Error(t0("메모 저장소를 사용할 수 없습니다", "Comment storage is unavailable"));
      await this.io.commentResolve(target.path, comment.id, !comment.resolved, { text: comment.text, resolved: comment.resolved });
    });
  }

  async removeComment(target: { id: string; path: string }, comment: DocComment): Promise<void> {
    await this.mutateComments(target, async () => {
      if (!this.io.commentRemove) throw new Error(t0("메모 저장소를 사용할 수 없습니다", "Comment storage is unavailable"));
      await this.io.commentRemove(target.path, comment.id, { text: comment.text, resolved: comment.resolved });
    });
  }

  private backlinksVersion = 0;
  private backlinksRequest: Promise<void> | null = null;

  private invalidateBacklinks(): void {
    this.backlinksVersion += 1;
    this.state.linksRevision += 1;
    if (this.backlinksTimer) clearTimeout(this.backlinksTimer);
    this.backlinksTimer = null;
    this.backlinksCache.clear();
    for (const tab of this.state.tabs) tab.backlinks = null;
  }

  private documentLinksChanged(path: string): void {
    const root = this.state.workspace?.replace(/\/+$/, "");
    if (root === undefined || root === null) return;
    const changed = path.replace(/\/+$/, "");
    if (changed !== root && !changed.startsWith(`${root}/`) && !root.startsWith(`${changed}/`)) return;
    this.invalidateBacklinks();
    this.emit();
    this.scheduleBacklinks();
  }

  private scheduleBacklinks(): void {
    if (this.backlinksTimer) clearTimeout(this.backlinksTimer);
    const tab = this.active;
    if (!tab?.path || !this.state.workspace || !this.io.backlinks) return;
    const cached = this.backlinksCache.get(tab.path);
    if (cached !== undefined) {
      tab.backlinks = cached;
      this.emit();
      return;
    }
    const path = tab.path;
    const root = this.state.workspace;
    const version = this.backlinksVersion;
    this.backlinksTimer = setTimeout(() => {
      this.backlinksTimer = null;
      const previous = this.backlinksRequest;
      const request = (async () => {
        await previous;
        if (this.state.workspace !== root || this.backlinksVersion !== version || this.active?.path !== path) return;
        try {
          const hits = await this.io.backlinks!(root, path);
          if (this.state.workspace !== root || this.backlinksVersion !== version) return;
          this.backlinksCache.set(path, hits.length);
          for (const tab of this.state.tabs) {
            if (tab.path === path) tab.backlinks = hits.length;
          }
          this.emit();
        } catch { /* Unknown counts stay null; the backlinks panel exposes retry/errors. */ }
      })();
      this.backlinksRequest = request;
      void request.then(() => { if (this.backlinksRequest === request) this.backlinksRequest = null; });
    }, 400);
  }

  applyDocStyleVars(): void {
    if (!this.hostEl) return;
    const tab = this.active;
    applyDocStyle(
      this.hostEl,
      tab?.docStyle ?? null,
      this.state.settings.fontSize,
      this.state.settings.lineWidth,
    );
    // 행간·글꼴 크기가 바뀌면 CM의 높이 추정이 어긋나 스크롤이 뛸 수 있다 —
    // 즉시 재측정을 잡는다.
    this.view?.requestMeasure();
  }

  private bookmarkReads = new Map<string, number>();
  private bookmarkReadSequence = 0;
  private bookmarkMutations = new Set<string>();
  private bookmarkWriteErrors = new Map<string, string>();
  private bookmarkAnchorErrors = new Map<string, string>();
  private bookmarkRetries = new Map<string, { id: string; path: string; doc: EditorState["doc"]; line: number; present: boolean }>();
  private bookmarkCache = new WeakMap<Tab, { doc: EditorState["doc"]; text: string | null; lines: number[]; mapped: number[] }>();

  /** 저장된 기준 좌표를 현재 버퍼에 투영한다. 입력·되돌리기 중에도 위치를 유지한다. */
  bookmarkLinesFor(tab: Tab): number[] {
    const doc = tab === this.active && this.view ? this.view.state.doc : tab.state.doc;
    const cached = this.bookmarkCache.get(tab);
    if (cached?.doc === doc && cached.text === tab.bookmarksText && cached.lines === tab.bookmarks) return cached.mapped;
    const mapped = tab.bookmarksText === null || !tab.bookmarks.length ? [] : [...new Set(shiftLineNumbers(tab.bookmarks, tab.bookmarksText, doc.toString()).filter((line) => line > 0))].sort((a, b) => a - b);
    this.bookmarkCache.set(tab, { doc, text: tab.bookmarksText, lines: tab.bookmarks, mapped });
    return mapped;
  }

  private applyBookmarks(path: string, snapshot: BookmarkSnapshot): void {
    for (const tab of this.state.tabs) {
      if (tab.path !== path || snapshot.revision < tab.bookmarksRevision) continue;
      tab.bookmarks = snapshot.lines;
      tab.bookmarksText = snapshot.text;
      tab.bookmarksRevision = snapshot.revision;
      tab.bookmarksError = this.bookmarkWriteErrors.get(path) ?? this.bookmarkAnchorErrors.get(path) ?? null;
    }
    if (this.active?.path === path) this.applyConfig();
    this.emit();
  }

  async refreshBookmarks(path: string | null = this.active?.path ?? null): Promise<boolean> {
    if (!path) return false;
    const targets = this.state.tabs.filter((tab) => tab.path === path);
    if (!targets.length) return false;
    const version = ++this.bookmarkReadSequence;
    this.bookmarkReads.set(path, version);
    for (const tab of targets) tab.bookmarksLoading = true;
    this.emit();
    try {
      if (!this.io.bookmarkList) throw new Error(t0("책갈피 저장소를 사용할 수 없습니다", "Bookmark storage is unavailable"));
      const snapshot = await this.io.bookmarkList(path);
      if (this.bookmarkReads.get(path) === version) this.applyBookmarks(path, snapshot);
      return true;
    } catch (error) {
      if (this.bookmarkReads.get(path) === version) {
        for (const tab of targets) if (tab.path === path) tab.bookmarksError = String(error);
      }
      return false;
    } finally {
      if (this.bookmarkReads.get(path) === version) {
        this.bookmarkReads.delete(path);
        for (const tab of targets) if (tab.path === path) tab.bookmarksLoading = false;
        this.emit();
      }
    }
  }

  /** 성공한 요청만 표시한다. 진행 중 같은 문서의 토글을 중복 제출하지 않는다. */
  async toggleBookmark(): Promise<boolean> {
    this.syncActiveState();
    const tab = this.active;
    const view = this.view;
    if (!tab?.path || !view || this.bookmarkMutations.has(tab.path)) return false;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    if (tab.bookmarksText === null) {
      this.toast(t0("책갈피를 먼저 불러와 주세요. 목차에서 다시 시도할 수 있습니다.", "Load bookmarks first. You can retry from the outline."), "error");
      return false;
    }
    return this.writeBookmark({ id: tab.id, path: tab.path, doc: view.state.doc, line, present: !this.bookmarkLinesFor(tab).includes(line) });
  }

  private async writeBookmark(intent: { id: string; path: string; doc: EditorState["doc"]; line: number; present: boolean }): Promise<boolean> {
    if (this.bookmarkMutations.has(intent.path)) return false;
    this.bookmarkMutations.add(intent.path);
    for (const tab of this.state.tabs) if (tab.path === intent.path) tab.bookmarksBusy = true;
    this.emit();
    try {
      return await this.queueDocumentOp(intent.id, async () => {
        this.syncActiveState();
        const tab = this.state.tabs.find((item) => item.id === intent.id && item.path === intent.path);
        if (!tab || tab.state.doc !== intent.doc || this.discardingTabIds.has(intent.id)) {
          throw new Error(t0("문서가 바뀌었습니다. 책갈피 위치를 다시 선택하세요.", "The document changed. Select the bookmark location again."));
        }
        if (!this.io.bookmarkSet || !this.io.bookmarkList) throw new Error(t0("책갈피 저장소를 사용할 수 없습니다", "Bookmark storage is unavailable"));
        const snapshot = await this.io.bookmarkList(intent.path);
        this.applyBookmarks(intent.path, snapshot);
        this.syncActiveState();
        if (!this.state.tabs.includes(tab) || tab.path !== intent.path || tab.state.doc !== intent.doc || this.discardingTabIds.has(intent.id)) {
          throw new Error(t0("문서가 바뀌었습니다. 책갈피 위치를 다시 선택하세요.", "The document changed. Select the bookmark location again."));
        }
        const line = shiftLineNo(intent.line, intent.doc.toString(), snapshot.text);
        if (line < 1) throw new Error(t0("새로 입력한 줄에 책갈피를 추가하려면 먼저 문서를 저장하세요.", "Save the document before bookmarking newly inserted text."));
        const saved = await this.io.bookmarkSet(intent.path, line, intent.present, snapshot.text);
        this.bookmarkRetries.delete(intent.id);
        this.bookmarkWriteErrors.delete(intent.path);
        this.applyBookmarks(intent.path, saved);
        return true;
      });
    } catch (error) {
      if (this.state.tabs.some((tab) => tab.id === intent.id && tab.path === intent.path)) {
        this.bookmarkRetries.set(intent.id, intent);
        this.bookmarkWriteErrors.set(intent.path, String(error));
      }
      for (const tab of this.state.tabs) if (tab.path === intent.path) tab.bookmarksError = String(error);
      this.toast(`${t0("책갈피를 저장하지 못했습니다", "Could not save bookmark")}: ${String(error)}`, "error");
      return false;
    } finally {
      this.bookmarkMutations.delete(intent.path);
      for (const tab of this.state.tabs) if (tab.path === intent.path) tab.bookmarksBusy = false;
      this.emit();
    }
  }

  /** 원자적 위치 교체. 실패해도 DB의 이전 목록과 기준 본문이 함께 남는다. */
  private async reanchorBookmarks(tab: Tab, path: string, text: string): Promise<boolean> {
    try {
      if (!this.io.bookmarkList || !this.io.bookmarkReplace) throw new Error(t0("책갈피 저장소를 사용할 수 없습니다", "Bookmark storage is unavailable"));
      const current = await this.io.bookmarkList(path);
      const lines = [...new Set(shiftLineNumbers(current.lines, current.text, text).filter((line) => line > 0))].sort((a, b) => a - b);
      const saved = current.text === text ? current : await this.io.bookmarkReplace(path, text, lines, { text: current.text, lines: current.lines });
      this.bookmarkAnchorErrors.delete(path);
      this.applyBookmarks(path, saved);
      return true;
    } catch (error) {
      this.bookmarkAnchorErrors.set(path, String(error));
      tab.bookmarksError = String(error);
      this.toast(`${t0("문서는 저장됐지만 책갈피 위치를 저장하지 못했습니다", "Document saved, but bookmark positions could not be saved")}: ${String(error)}`, "error");
      this.emit();
      return false;
    }
  }

  async retryBookmarks(id = this.state.activeId): Promise<boolean> {
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab?.path || tab.bookmarksBusy || this.bookmarkMutations.has(tab.path)) return false;
    const intent = this.bookmarkRetries.get(tab.id);
    if (intent) return this.writeBookmark(intent);
    if (!this.bookmarkAnchorErrors.has(tab.path)) return this.refreshBookmarks(tab.path);
    const path = tab.path;
    this.bookmarkMutations.add(path);
    tab.bookmarksBusy = true;
    this.emit();
    try {
      return await this.queueDocumentOp(tab.id, async () => {
        if (!this.state.tabs.includes(tab) || tab.path !== path) return false;
        return this.reanchorBookmarks(tab, path, tab.savedText);
      });
    } finally {
      this.bookmarkMutations.delete(path);
      tab.bookmarksBusy = false;
      this.emit();
    }
  }

  gotoBookmark(line: number): void {
    this.revealLocation({ line });
  }

  cycleBookmark(forward: boolean): void {
    const tab = this.active;
    if (!tab || !this.view) return;
    const mapped = this.bookmarkLinesFor(tab);
    if (!mapped.length) return;
    const current = this.view.state.doc.lineAt(this.view.state.selection.main.head).number;
    const marks = forward ? mapped : [...mapped].reverse();
    this.gotoBookmark(marks.find((line) => forward ? line > current : line < current) ?? marks[0]);
  }

  /** 표 표시 폭 저장 — 헤더 내용 키로(줄 이동에 불변), 구 줄 번호 키는 제거.
   *  원문 불변 사이드카. */
  setTableWidths(lineNo: number, key: string, widths: number[]): void {
    const tab = this.active;
    if (!tab) return;
    const prev = { ...(tab.docStyle?.tableWidths ?? {}) };
    delete prev[String(lineNo)]; // 구 키 정리(같은 표를 다시 저장할 때)
    const style: DocStyle = {
      ...(tab.docStyle ?? DEFAULT_DOC_STYLE_T),
      tableWidths: { ...prev, [key]: widths },
    };
    this.setDocStyle(style);
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

  /** 문단 정렬(Word ⌘L/E/R/J) — 문서 스타일 사이드카에만. */
  setAlign(align: DocStyle["textAlign"]): void {
    const tab = this.active;
    if (!tab) return;
    this.setDocStyle({ ...(tab.docStyle ?? DEFAULT_DOC_STYLE_T), textAlign: align });
  }

  /** 즉시 미리보기하되 디스크 쓰기는 문서별로 모아서 처리한다(원문 불변). */
  setDocStyle(style: DocStyle, id = this.state.activeId): void {
    const tab = this.state.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.docStyle = style;
    this.pendingDocStyles.set(tab.id, { tab, json: JSON.stringify(style) });
    if (tab === this.active) this.applyConfig();
    this.emit();
    const previous = this.docStyleTimers.get(tab.id);
    if (previous) clearTimeout(previous);
    this.docStyleTimers.set(tab.id, setTimeout(() => {
      this.docStyleTimers.delete(tab.id);
      void this.queueDocumentOp(tab.id, () => this.persistDocStyle(tab.id));
    }, 350));
    // 제목 없는 문서는 스타일만 바꿔도 복구할 문서가 생긴다.
    if (!tab.path) void this.saveDraftOf(tab.id, true);
  }

  private docStyleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingDocStyles = new Map<string, { tab: Tab; json: string }>();
  private docStyleFailures = new Set<string>();

  private stopDocStyleTimer(id: string): void {
    const timer = this.docStyleTimers.get(id);
    if (timer) clearTimeout(timer);
    this.docStyleTimers.delete(id);
  }

  /** documentOps 안에서 호출한다. 저장 대상은 활성 탭이 아닌 변경한 문서다. */
  private async persistDocStyle(id: string): Promise<boolean> {
    this.stopDocStyleTimer(id);
    while (this.pendingDocStyles.has(id)) {
      this.stopDocStyleTimer(id);
      const pending = this.pendingDocStyles.get(id)!;
      const key = pending.tab.path ?? pending.tab.draftKey;
      if (!key) return false;
      try {
        await this.io.docStyleSet?.(key, pending.json);
        this.docStyleFailures.delete(id);
        if (this.pendingDocStyles.get(id) === pending) this.pendingDocStyles.delete(id);
      } catch (e) {
        if (!this.docStyleFailures.has(id)) {
          this.docStyleFailures.add(id);
          this.toast(`${t0("문서 스타일을 저장하지 못했습니다. 저장을 다시 시도해 주세요", "Could not save document style. Please try saving again")}: ${String(e)}`, "error");
        }
        return false;
      }
    }
    return true;
  }

  /** 닫힌 탭의 남은 스타일 쓰기도 포함한다. 실패 항목은 재시도를 위해 유지한다. */
  async flushDocStyles(ids?: readonly string[]): Promise<boolean> {
    const selected = (id: string) => !ids || ids.includes(id);
    for (const id of [...this.docStyleTimers.keys()]) {
      if (selected(id)) this.stopDocStyleTimer(id);
    }
    let success = true;
    for (const id of [...this.pendingDocStyles.keys()]) {
      if (!selected(id)) continue;
      if (!(await this.queueDocumentOp(id, () => this.persistDocStyle(id)))) success = false;
    }
    return success;
  }

  // — 세션 —

  /** 복원하지 못한 참조는 다음 세션에도 남긴다. 파일 접근 실패는 삭제 의사가 아니다. */
  private unavailableSessionTabs = new Map<string, SessionTab>();
  private restoring = false;

  async restoreSession(session: SessionState): Promise<void> {
    if (this.restoring) return;
    this.restoring = true;
    if (this.sessionSaveTimer) {
      clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }
    try {
      await this.restoreSessionInner(session);
    } finally {
      this.restoring = false;
      this.scheduleSessionSave();
    }
    void this.loadRecent();
    void this.syncWatch();
  }

  /** 복구 저장소나 외장 디스크가 다시 사용 가능해졌을 때 재시도한다. */
  async retryRecovery(): Promise<void> {
    await this.restoreSession(this.buildSession());
  }

  private async restoreSessionInner(session: SessionState): Promise<void> {
    this.pinnedTabId = null;
    this.pendingPinnedPath = session.pinnedPath ?? null;
    this.collapsedFolders = new Set(session.collapsedFolders ?? []);
    this.tocCollapsed = new Set(session.tocCollapsed ?? []);
    this.pendingLockedPaths = new Set(session.lockedPaths ?? []);
    this.state.sidebarWidth = session.sidebarWidth ?? 240;
    this.state.tocOpen = session.tocOpen;
    if (session.workspace) await this.openWorkspace(session.workspace);
    this.state.sidebarOpen = session.sidebarOpen;
    const entries = session.tabs.map((entry) => ({ ...entry }));
    const issues: string[] = [];
    try {
      const drafts = await this.io.draftList?.() ?? [];
      const used = new Set(entries.map((entry) => entry.draftKey).filter(Boolean));
      // 구버전 세션은 경로만 기록했다. 같은 파일의 최신 초안을 기본 탭에 연결한다.
      for (const entry of entries) {
        if (entry.draftKey || !entry.path) continue;
        const candidate = drafts.filter((draft) => draft.path === entry.path && !used.has(draft.key))
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (candidate) {
          entry.draftKey = candidate.key;
          used.add(candidate.key);
        }
      }
      const known = new Set(entries.map((entry) => entry.draftKey ?? entry.path).filter(Boolean));
      for (const draft of drafts) {
        if (!known.has(draft.key)) {
          known.add(draft.key);
          entries.push({ path: draft.path, draftKey: draft.key,
            mode: this.state.settings.defaultMode, cursor: 0, scroll: 0 });
        }
      }
    } catch (e) {
      issues.push(String(e));
    }
    let recovered = 0;
    const visitedKeys = new Set<string>();
    // 순서를 유지하며 한 문서씩 읽는다. 많은 탭의 본문·초안을 한꺼번에 복제하지 않는다.
    for (const entry of entries) {
      const key = entry.draftKey ?? entry.path ?? nextDraftKey();
      if (visitedKeys.has(key)) continue;
      visitedKeys.add(key);
      if (this.state.tabs.some((tab) => tab.draftKey === key)) continue;
      const [disk, recovery] = await Promise.allSettled([
        entry.path ? this.io.readDocument(entry.path) : Promise.resolve(null),
        this.io.draftLoad?.(key) ?? Promise.resolve(null),
      ]);
      let doc = disk.status === "fulfilled" ? disk.value : null;
      // 읽기 오류를 '초안 없음'으로 처리하면 다음 입력이 원래 초안을 덮어쓴다.
      if (recovery.status === "rejected") {
        this.unavailableSessionTabs.set(key, entry);
        issues.push(`${entry.path ?? key}: ${String(recovery.reason)}`);
        continue;
      }
      const draft = recovery.value;
      // 초안 저장과 세션 저장 사이에 종료됐다면 초안의 경로가 더 최신이다.
      if (draft && draft.path !== entry.path) {
        entry.path = draft.path;
        try { doc = entry.path ? await this.io.readDocument(entry.path) : null; }
        catch { doc = null; }
      }
      if (entry.path && !doc && !draft) {
        this.unavailableSessionTabs.set(key, entry);
        issues.push(entry.path);
        continue;
      }
      this.unavailableSessionTabs.delete(key);
      const text = draft?.content ?? doc?.text ?? "";
      const dirty = draft !== null && (!doc || text !== doc.text);
      const conflict: Tab["conflict"] = entry.path && !doc ? "removed"
        : dirty && doc && (draft?.baseText == null || draft.baseText !== doc.text) ? "conflict" : null;
      const body = stripFrontMatter(text);
      const tab: Tab = {
        id: `t${nextTabId++}`, path: entry.path,
        draftKey: draft?.key ?? entry.draftKey ?? nextDraftKey(entry.path ? "document" : "untitled"),
        title: entry.path ? baseName(entry.path) : "",
        state: createDocState(text, entry.mode), mode: entry.mode,
        savedText: doc?.text ?? draft?.baseText ?? "",
        meta: doc?.meta ?? draft?.meta ?? { hadBom: false, crlf: false },
        savedMtime: doc?.mtime ?? 0, savedAt: (doc?.mtime ?? 0) * 1000,
        scroll: Math.max(0, Number.isFinite(draft?.scroll ?? entry.scroll) ? (draft?.scroll ?? entry.scroll) : 0),
        cursorLine: 1, cursorCol: 1, conflict, docStyle: null,
        marks: { bold: false, italic: false, strike: false, code: false, link: false },
        selChars: 0, checkbox: checkboxOf(text), backlinks: null, bookmarks: [], bookmarksText: null, bookmarksRevision: -1, bookmarksLoading: false, bookmarksBusy: false, bookmarksError: null,
        commentLines: [], comments: [], commentsLoading: false, commentsLoaded: false, commentsError: null, baselineText: null, baselineRevision: -1, baselineLoaded: false, baselineLoading: false, baselineBusy: false, baselineError: null, trackStats: null,
        dirty, words: countWords(body), chars: body.length,
      };
      const cursor = draft?.cursor ?? entry.cursor;
      const offset = Math.min(tab.state.doc.length, Math.max(0, Number.isFinite(cursor) ? Math.floor(cursor) : 0));
      tab.state = tab.state.update({ selection: { anchor: offset } }).state;
      const line = tab.state.doc.lineAt(offset);
      tab.cursorLine = line.number;
      tab.cursorCol = offset - line.from + 1;
      this.state.tabs.push(tab);
      if (draft && dirty) recovered += 1;
      await this.loadTabMetadata(tab);
      if (entry.path) {
        void this.io.setAssetScope(dirname(entry.path), true).catch(() => {});
      }
    }
    const active = this.findSessionTab(session.active)
      ?? this.active ?? this.state.tabs[0];
    if (active) this.activate(active.id);
    const pinned = this.findSessionTab(session.pinnedPath);
    if (pinned) this.pinnedTabId = pinned.id;
    for (const key of session.lockedPaths ?? []) {
      const locked = this.findSessionTab(key);
      if (locked) this.setLocked(locked.id, true);
    }
    if (recovered > 0) this.toast(t0(`${recovered}개 문서의 미저장 내용을 복원했습니다`, `Recovered unsaved changes in ${recovered} document(s)`));
    if (issues.length) this.toast(`${t0("일부 문서를 복원하지 못했습니다. 복구 정보는 보존했습니다", "Some documents could not be restored. Recovery data was preserved")}: ${issues.slice(0, 3).join("; ")}`, "error");
    this.emit();
  }

  /** 새 세션은 초안 키, 구버전 세션은 파일 경로로 탭을 가리킨다. */
  findSessionTab(key: string | null | undefined): Tab | undefined {
    if (!key) return undefined;
    return this.state.tabs.find((tab) => tab.draftKey === key)
      ?? this.state.tabs.find((tab) => tab.path === key);
  }

  buildSession(): SessionState {
    this.syncActiveState();
    return {
      version: 1,
      tabs: [...this.state.tabs.map((t) => ({
        path: t.path,
        draftKey: t.draftKey,
        mode: t.mode,
        cursor: t.state.selection.main.head,
        scroll: Math.round(t.scroll),
      })), ...[...this.unavailableSessionTabs.values()].filter((entry) =>
        !this.findSessionTab(entry.draftKey ?? entry.path))],
      active: this.active?.draftKey ?? this.active?.path ?? null,
      workspace: this.state.workspace,
      collapsedFolders: [...this.collapsedFolders].sort(),
      tocCollapsed: [...this.tocCollapsed].sort(),
      lockedPaths: [...this.lockedTabIds]
        .map((id) => {
          const tab = this.state.tabs.find((t) => t.id === id);
          return tab?.draftKey ?? tab?.path;
        })
        .filter((p): p is string => !!p),
      pinnedPath:
        this.pinnedTabId != null
          ? ((this.state.tabs.find((t) => t.id === this.pinnedTabId)?.draftKey
            ?? this.state.tabs.find((t) => t.id === this.pinnedTabId)?.path) ?? null)
          : null,
      sidebarOpen: this.state.sidebarOpen,
      sidebarWidth: this.state.sidebarWidth,
      tocOpen: this.state.tocOpen,
      window: this.windowRect,
      auxWindow: this.auxWindowRect ?? null,
    };
  }

  /** 창 위치·크기 — App이 이동/리사이즈 때마다 기록한다(세션 복원용). */
  windowRect: SessionState["window"] = null;

  setWindowRect(rect: NonNullable<SessionState["window"]>): void {
    this.windowRect = rect;
  }

  /** 보조 창(새 창으로 열기) 위치 — 세션에 남겨 다음 보조 창이 같은 자리에. */
  auxWindowRect: SessionState["auxWindow"] = null;

  setAuxWindowRect(rect: NonNullable<SessionState["auxWindow"]>): void {
    this.auxWindowRect = rect;
  }

  scheduleSessionSave(): void {
    if (this.restoring) return;
    if (this.sessionSaveTimer) clearTimeout(this.sessionSaveTimer);
    this.sessionSaveTimer = setTimeout(() => {
      this.sessionSaveTimer = null;
      if (this.restoring) return; // 복원이 끝나면 다시 예약된다
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

  private recentRevision = -1;
  private recentRead = 0;
  private recentOps: Promise<unknown> = Promise.resolve();
  private recentActions = 0;

  acceptRecent(snapshot: RecentSnapshot): void {
    if (snapshot.revision < this.recentRevision) return;
    this.recentRevision = snapshot.revision;
    this.recentRead += 1;
    this.state.recent = snapshot.entries;
    this.state.recentError = null;
    this.state.recentLoading = false;
    this.emit();
  }

  /** 조회/이벤트/변경 응답이 뒤섞여도 최신 서버 순번만 반영한다. */
  async loadRecent(): Promise<void> {
    if (!this.io.getRecent) return;
    const request = ++this.recentRead;
    this.state.recentLoading = true;
    this.emit();
    try {
      const snapshot = await this.io.getRecent();
      if (request === this.recentRead) this.state.recentLoading = false;
      this.acceptRecent(snapshot);
      this.emit();
    } catch (error) {
      if (request === this.recentRead) {
        this.state.recentError = String(error);
        this.state.recentLoading = false;
        this.emit();
      }
    }
  }

  private queueRecent(run: () => Promise<RecentSnapshot>, action = false): Promise<boolean> {
    if (action) {
      this.recentActions += 1;
      this.state.recentBusy = true;
      this.emit();
    }
    const operation = this.recentOps.then(async () => {
      try {
        this.acceptRecent(await run());
        return true;
      } catch (error) {
        this.state.recentError = String(error);
        if (action) this.toast(`${t0("최근 문서 목록을 변경하지 못했습니다", "Could not update recent documents")}: ${String(error)}`, "error");
        this.emit();
        return false;
      } finally {
        if (action) {
          this.recentActions -= 1;
          this.state.recentBusy = this.recentActions > 0;
          this.emit();
        }
      }
    });
    this.recentOps = operation;
    return operation;
  }

  recordRecent(path: string): Promise<boolean> {
    return this.io.recordRecent ? this.queueRecent(() => this.io.recordRecent!(path)) : Promise.resolve(false);
  }

  private favoritesRevision = -1;
  private favoritesRead = 0;
  private favoriteOps: Promise<unknown> = Promise.resolve();
  private favoriteActions = 0;

  isFavorite(path: string): boolean { return this.state.favorites.includes(path); }

  acceptFavorites(snapshot: FavoritesSnapshot): void {
    if (snapshot.revision < this.favoritesRevision) return;
    this.favoritesRevision = snapshot.revision;
    this.favoritesRead += 1;
    this.state.favorites = [...snapshot.paths];
    this.state.favoritesLoaded = true;
    this.state.favoritesLoading = false;
    this.emit();
  }

  async loadFavorites(): Promise<void> {
    if (!this.io.getFavorites) return;
    const request = ++this.favoritesRead;
    this.state.favoritesLoading = true; this.emit();
    try {
      const snapshot = await this.io.getFavorites();
      if (request === this.favoritesRead) this.state.favoritesError = null;
      this.acceptFavorites(snapshot);
    } catch (error) {
      if (request === this.favoritesRead) this.state.favoritesError = String(error);
    } finally {
      if (request === this.favoritesRead) { this.state.favoritesLoading = false; this.emit(); }
    }
  }

  /** Explicit membership makes double clicks and cross-window retries idempotent. */
  setFavorite(path: string, present: boolean): Promise<boolean> {
    if (!this.io.setFavorite) return Promise.resolve(false);
    return this.queueFavorite(() => this.io.setFavorite!(path, present));
  }

  moveFavorite(path: string, direction: "up" | "down"): Promise<boolean> {
    const index = this.state.favorites.indexOf(path);
    if (!this.io.moveFavorite || !this.state.favoritesLoaded || this.state.favoritesBusy || this.state.favoritesLoading || index < 0 ||
      (direction === "up" ? index === 0 : index === this.state.favorites.length - 1)) return Promise.resolve(false);
    const expectedRevision = this.favoritesRevision;
    return this.queueFavorite(() => {
      if (this.favoritesRevision !== expectedRevision) throw { code: "changed" };
      return this.io.moveFavorite!(path, direction, expectedRevision);
    });
  }

  private queueFavorite(run: () => Promise<FavoritesSnapshot>): Promise<boolean> {
    this.favoriteActions += 1; this.state.favoritesBusy = true; this.emit();
    const operation = this.favoriteOps.then(async () => {
      try {
        this.acceptFavorites(await run());
        this.state.favoritesError = null;
        return true;
      } catch (error) {
        this.state.favoritesError = typeof error === "object" && error !== null && "code" in error && error.code === "changed"
          ? t0("즐겨찾기 목록이 바뀌었습니다. 목록을 다시 불러온 뒤 순서를 변경해 주세요.", "Favorites changed. Reload the list before moving this document again.")
          : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
        this.toast(`${t0("즐겨찾기를 저장하지 못했습니다", "Could not save favorites")}: ${this.state.favoritesError}`, "error");
        return false;
      } finally {
        this.favoriteActions -= 1;
        this.state.favoritesBusy = this.favoriteActions > 0;
        this.emit();
      }
    });
    this.favoriteOps = operation;
    return operation;
  }

  removeRecent(path: string): Promise<boolean> {
    return this.io.removeRecent ? this.queueRecent(() => this.io.removeRecent!(path), true) : Promise.resolve(false);
  }

  clearRecent(): Promise<boolean> {
    return this.io.clearRecent ? this.queueRecent(() => this.io.clearRecent!(), true) : Promise.resolve(false);
  }

  toast(text: string, kind: "info" | "error" = "info"): void {
    const t = { id: nextToastId++, text, kind, leaving: false };
    this.state.toasts = [...this.state.toasts, t];
    this.emit();
    setTimeout(() => {
      // 이미 사용자가 닫았으면 건드리지 않는다.
      if (!this.state.toasts.some((x) => x.id === t.id)) return;
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

  /** 토스트 조기 닫기(클릭). */
  dismissToast(id: number): void {
    if (!this.state.toasts.some((x) => x.id === id)) return;
    this.state.toasts = this.state.toasts.filter((x) => x.id !== id);
    this.emit();
  }

}

/** 단어 수 — 한글은 음절을, 라틴은 단어를 센다(대략적 지표).
 *  편집 델타의 삽입·삭제 조각에만 돌리므로 입력 비용은 입력량에 비례한다. */
export function countWords(text: string): number {
  const cjk = (text.match(/[가-힣぀-ヿ一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9'’_-]+/g) ?? []).length;
  return cjk + latin;
}

/** GFM 작업 항목 진행률 — [ ]·[x] 개수(줄 머리 목록 마커 뒤만). 순수 함수. */
export function countCheckboxes(text: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const m of text.matchAll(/^ {0,3}(?:[-*+]|\d+[.)]) \[([ xX])\]/gm)) {
    total++;
    if (m[1] !== " ") done++;
  }
  return { done, total };
}

const isWsChar = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

/** pos를 왼쪽 단어 경계(공백 지나서)로 확장. */
function expandWordStart(doc: { sliceString(f: number, t: number): string }, pos: number): number {
  let p = pos;
  while (p > 0 && !isWsChar(doc.sliceString(p - 1, p))) p--;
  return p;
}

/** pos를 오른쪽 단어 경계로 확장. */
function expandWordEnd(doc: { sliceString(f: number, t: number): string }, pos: number): number {
  let p = pos;
  let guard = 0;
  while (guard++ < 1_000_000) {
    const ch = doc.sliceString(p, p + 1);
    if (ch === "" || isWsChar(ch)) break;
    p++;
  }
  return p;
}

function checkboxOf(text: string): { done: number; total: number } | null {
  const { done, total } = countCheckboxes(text);
  return total > 0 ? { done, total } : null;
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

/** 목차 기본 표시 여부 — 세션에 기록이 없으면 연다. */
export function defaultSessionToc(): boolean {
  return true;
}

export function defaultSettings(): Settings {
  return {
    theme: "auto",
    fontSize: 15,
    lineWidth: 0,
    defaultMode: "edit",
    remoteImages: true,
    language: "auto",
    showImages: true,
    logLevel: "info",
    autosave: true,
    typewriter: false,
    focusMode: false,
    sourcePreview: true,
    smartPunctuation: true,
    longSentenceMarks: false,
    formattingMarks: false,
    longSentenceMin: 60,
    autoFormatTables: false,
    writingGoal: 0,
    searchCase: false,
    searchRegex: false,
    searchWord: false,
    searchQuery: "",
    exportPaper: "a4",
    exportLandscape: false,
    exportMarginMm: 14,
    exportScale: 1,
    exportPageNumbers: true,
    exportHeader: true,
    focusSentence: false,
    ttsRate: 175,
    ttsVoice: "",
    spellcheck: false,
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
