// Tauri 명령 래퍼. 브라우저(vite dev 단독)에서는 안전하게 실패한다 —
// 순수 로직 모듈(store·links 등)은 이 파일을 import하지 않고,
// 컴포넌트/App 레벨에서만 쓴다(단위 테스트 가능성 유지).
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";

export interface DocMeta {
  hadBom: boolean;
  crlf: boolean;
}

export interface UserTemplateInfo { id: string; name: string; description: string; version: number }
export interface UserTemplate extends UserTemplateInfo { content: string }
export interface UserTemplateList { revision: number; templates: UserTemplateInfo[] }
export interface UserTemplateInput { id: string; name: string; description: string; content: string; expectedVersion: number | null }
export interface TemplateArchive { format: "iyagi-markdown-templates"; version: 1; templates: Array<{ name: string; description: string; content: string }> }
export type WorkspaceHistoryAction = { kind: "record" | "remove"; path: string } | { kind: "clear" };

export interface TrashDocument {
  root: string;
  path: string;
  canonicalRoot: string;
  stamp: string;
  size: number;
}

export interface LoadedDoc {
  text: string;
  meta: DocMeta;
  mtime: number;
  size: number;
}

export interface WriteOutcome {
  mtime: number;
  size: number;
}

export type WriteExpectation =
  | { kind: "match"; text: string; meta: DocMeta }
  | { kind: "missing" }
  | { kind: "overwrite" };

export function isWriteConflict(error: unknown): error is { code: "conflict" | "removed"; message: string } {
  return typeof error === "object" && error !== null &&
    "code" in error && (error.code === "conflict" || error.code === "removed") &&
    "message" in error && typeof error.message === "string";
}

export interface TreeNode {
  kind: "dir" | "file";
  name: string;
  path: string;
  stem?: string;
  children?: TreeNode[];
}

export interface WorkspaceScan {
  tree: TreeNode[];
  issues: Array<{ path: string; code: "read" | "encoding" | "depth" | "limit"; message: string }>;
}

/** Both endpoints are resolved document paths in the scanned workspace. */
export interface DocumentEdge {
  from: string;
  to: string;
}

export interface MissingLink {
  kind: "wiki" | "file";
  name: string;
  from: number;
  line: number;
  createPath: string | null;
}
export interface LinkInspection {
  links: MissingLink[];
  issues: Array<{ path: string; code: string; message: string }>;
  checked: number;
}

export interface Settings {
  theme: "auto" | "light" | "dark";
  fontSize: number;
  lineWidth: number;
  defaultMode: "edit" | "read" | "source";
  remoteImages: boolean;
  language: "auto" | "en" | "ko";
  showImages: boolean;
  logLevel: string;
  autosave: boolean;
  /** 타이프라이터 스크롤 — 입력 줄을 화면 가운데 유지(Typora·iA). */
  typewriter: boolean;
  /** 포커스 모드 — 커서 문단 외 흐림. */
  focusMode: boolean;
  /** 문장 단위 포커스(iA Writer) — focusMode가 켜일 때만. */
  focusSentence: boolean;
  /** 소스 모드 오른쪽 읽기 미리보기 분할. */
  sourcePreview: boolean;
  /** TTS 읽기 속도(기준 175). */
  ttsRate: number;
  /** 스마트 문장부호 — 입력 시 문맥 변환(Word 자동 교정). */
  smartPunctuation: boolean;
  /** 긴 문장(60자+) 점선 밑줄 — 작가 보조. */
  longSentenceMarks: boolean;
  /** 긴 문장 임계값(자). */
  longSentenceMin: number;
  /** 서식 기호 보기(Word ¶) — 공백 ·· 탭 → 줄끝 ¶. */
  formattingMarks: boolean;
  /** 저장 시 표 서식 자동 정리. */
  autoFormatTables: boolean;
  /** 집필 목표 단어 수(0 = 없음). */
  writingGoal: number;
  /** 찾기 바 마지막 상태. */
  searchCase: boolean;
  searchRegex: boolean;
  searchWord: boolean;
  searchQuery: string;
  /** 읽기 목소리(빈 값 = 시스템 기본). */
  ttsVoice: string;
  /** 네이티브 맞춤법 검사. */
  spellcheck: boolean;
  /** 마지막 내보내기 옵션(재시작에도 유지 — Word 인쇄 설정 기억). */
  exportPaper: "a4" | "letter" | "a5";
  exportLandscape: boolean;
  exportMarginMm: number;
  exportScale: number;
  exportPageNumbers: boolean;
  exportHeader: boolean;
}

export interface DocComment {
  id: number;
  lineNo: number;
  text: string;
  createdAt: number;
  resolved: boolean;
}

export type CommentExpectation = Pick<DocComment, "text" | "resolved">;

export interface BookmarkSnapshot {
  lines: number[];
  text: string;
  revision: number;
}

export interface BaselineSnapshot {
  text: string | null;
  revision: number;
}

export interface FavoritesSnapshot {
  revision: number;
  paths: string[];
}

export interface SettingsSnapshot {
  revision: number;
  settings: Settings;
}

export interface SessionTab {
  path: string | null;
  /** 파일 경로와 별개인 창·탭별 초안 키. 구버전 세션은 생략할 수 있다. */
  draftKey?: string | null;
  mode: "edit" | "read" | "source";
  cursor: number;
  scroll: number;
}

/** 작성 초안 — 저장되지 않은 편집 내용의 임시저장(drafts.db). */
export interface Draft {
  key: string;
  path: string | null;
  content: string;
  cursor: number;
  scroll: number;
  updatedAt: number;
  baseText?: string | null;
  meta?: DocMeta | null;
}

export type DraftInfo = Pick<Draft, "key" | "path" | "updatedAt">;

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SessionState {
  version: number;
  tabs: SessionTab[];
  active: string | null;
  workspace: string | null;
  /** 참조 보기로 고정한 문서 경로. */
  pinnedPath?: string | null;
  /** 사이드바에서 접어 둔 폴더 경로들. */
  collapsedFolders?: string[];
  /** 목차 패널에서 접어 둔 제목 슬러그. */
  tocCollapsed?: string[];
  /** 읽기 전용 잠금 문서 경로들. */
  lockedPaths?: string[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  tocOpen: boolean;
  window: WindowRect | null;
  auxWindow?: WindowRect | null;
}

export interface RecentEntry {
  path: string;
  name: string;
}

export interface RecentSnapshot {
  revision: number;
  entries: RecentEntry[];
}

/** 워크스페이스 전체 검색 결과(줄 조각) — Rust search_tree와 같은 모양. */
export interface SearchHit {
  path: string;
  /** 1부터 시작. */
  lineNo: number;
  line: string;
}

export interface SearchReport {
  hits: SearchHit[];
  issues: Array<{ path: string; code: string; message: string }>;
  truncated: boolean;
  filesRead: number;
  filesTotal: number;
}

export interface PendingRename {
  id: number;
  root: string;
  from: string;
  to: string;
  ready: boolean;
  error: string | null;
}

export interface ReplacementPreview {
  id: number;
  files: Array<{ path: string; count: number; before: string; after: string }>;
  skipped: Array<{ path: string; message: string }>;
}

export interface ReplacementReport {
  applied: Array<{ path: string; count: number }>;
  failed: Array<{ path: string; message: string }>;
}

/** 버전 기록 스냅숏(저장이 교체한 이전 상태) — Rust snapshots.rs와 같은 모양. */
export interface SnapshotInfo {
  /** 에포크 밀리초. */
  ts: number;
  size: number;
}

export interface OrphanAsset {
  path: string;
  size: number;
  stamp: string;
}

export interface AssetTrashReport {
  moved: string[];
  failed: Array<{ path: string; message: string }>;
}

export interface PdfOptions {
  paper: "a4" | "letter" | "a5";
  orientation: "portrait" | "landscape";
  marginMm: number;
  scale: number;
  pageNumbers?: boolean;
}

export interface DocxManifest {
  math: Record<string, string>;
  diagrams: Record<string, string>;
  /** 문서별 스타일(폰트·크기) — DOCX 기본 서체에 반영. */
  style?: {
    font: "system" | "serif" | "round" | "mono";
    sizePt: number;
    lineHeight?: number;
    firstLineIndent?: boolean;
    textAlign?: "left" | "center" | "right" | "justify";
    accent?: string | null;
    pageNumbers?: boolean;
    highlight?: string | null;
  };
  imageWidths?: Record<string, number>;
  tableWidths?: Record<string, number[]>;
  /** 프런트매터 메타 — core.xml(dc:title·dc:creator). */
  title?: string;
  author?: string;
  /** 네이티브 목차(TOC 필드). */
  toc?: boolean;
  /** 그림 목차 / 표 목차. */
  lof?: boolean;
  lot?: boolean;
  /** 머리글 문서 제목(Some이면 매 페이지 상단). */
  headerTitle?: string;
  /** 문서 메모(본문 기준 줄 번호) — Word 원생 메모로. */
  comments?: Array<[number, string]>;
  /** 목차 라벨 언어. */
  frontLang?: string;
  /** 다단(1~3) — sectPr w:cols. */
  columns?: number;
  /** 바닥글 자유 텍스트 — footer1.xml. */
  footerText?: string;
}

/** 문서별 스타일(SQLite 사이드카 — .md 원문은 불변). */
export interface DocStyle {
  /** 문서 본문 폰트 */
  font: "system" | "serif" | "round" | "mono";
  /** pt. 0이면 전역 설정값. */
  fontSize: number;
  /** 0이면 기본(1.55). */
  lineHeight: number;
  paraSpace: "tight" | "normal" | "relaxed";
  /** 강조색 hex(#RRGGBB). null이면 기본. */
  accent: string | null;
  /** 문단 첫 줄 들여쓰기(한국어 문서 관례). */
  firstLineIndent: boolean;
  /** 문단 정렬 — left | center | right | justify(양쪽). */
  textAlign: "left" | "center" | "right" | "justify";
  /** 이미지 표시 폭(원본 경로 기준 퍼센트) — 원문은 불변, 사이드카에만. */
  imageWidths: Record<string, number>;
  /** 표 표시 폭(표 시작 줄 번호 → 열 px 배열) — 원문 불변 사이드카. */
  tableWidths: Record<string, number[]>;
  /** 형광펜(==..==) 색(RRGGBB, null = 기본 노랑). */
  highlightColor: string | null;
}

export interface AppInfo {
  version: string;
  lang: string;
  logDir: string | null;
}

let tauri: typeof import("@tauri-apps/api/core") | null = null;
let events: typeof import("@tauri-apps/api/event") | null = null;
let inApp = false;

export function initBridge(): boolean {
  inApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return inApp;
}

export function isInApp(): boolean {
  return inApp;
}

async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (!inApp) throw new Error(`이 명령은 앱 안에서만 쓸 수 있습니다: ${cmd}`);
  tauri ??= await import("@tauri-apps/api/core");
  return tauri.invoke<T>(cmd, args, options);
}

export const api = {
  appReady: () => invoke<void>("app_ready"),
  quitReply: (requestId: number, approved: boolean) =>
    invoke<boolean>("quit_reply", { requestId, approved }),
  quitPending: () => invoke<number | null>("quit_pending"),
  logError: (message: string) => invoke<void>("log_error", { message }),
  appInfo: () => invoke<AppInfo>("app_info"),
  takePendingFiles: () => invoke<string[]>("take_pending_files"),
  readDocument: (path: string) => invoke<LoadedDoc>("read_document", { path }),
  writeDocument: (path: string, text: string, meta: DocMeta, expected: WriteExpectation) =>
    invoke<WriteOutcome>("write_document", { path, text, meta, expected }),
  readFileBytes: (path: string) => invoke<number[]>("read_file_bytes", { path }),
  scanWorkspace: (root: string) => invoke<WorkspaceScan>("scan_workspace", { root }),
  searchWorkspace: (root: string, query: string, caseSensitive = false) =>
    invoke<SearchReport>("search_workspace", { root, query, caseSensitive }),
  previewReplacement: (root: string, needle: string, replacement: string, caseSensitive: boolean) =>
    invoke<ReplacementPreview>("preview_replacement", {
      root,
      needle,
      replacement,
      caseSensitive,
    }),
  applyReplacement: (id: number) => invoke<ReplacementReport>("apply_replacement", { id }),
  snapshotList: (path: string) => invoke<SnapshotInfo[]>("snapshot_list", { path }),
  snapshotBackup: (path: string, text: string) => invoke<void>("snapshot_backup", { path, text }),
  backlinks: (root: string, path: string) =>
    invoke<SearchHit[]>("backlinks", { root, path }),
  speakStart: (text: string, rate: number, voice: string) =>
    invoke<boolean>("speak_start", { text, rate, voice }),
  listVoices: () => invoke<Array<{ name: string; lang: string }>>("list_voices"),
  speakStop: () => invoke<void>("speak_stop"),
  speakStatus: () => invoke<boolean>("speak_status"),
  snapshotRead: (path: string, ts: number) => invoke<string>("snapshot_read", { path, ts }),
  getSettings: () => invoke<SettingsSnapshot>("get_settings"),
  patchSettings: (patch: Partial<Settings>) => invoke<SettingsSnapshot>("patch_settings", { patch }),
  getSession: () => invoke<SessionState | null>("get_session"),
  saveSession: (session: SessionState) => invoke<void>("save_session", { session }),
  // 웹 모드에는 초안 저장소가 없다. 읽기는 실제 값이 필요하므로 실패한다.
  draftSave: (draft: Draft) => (inApp ? invoke<void>("draft_save", { draft }) : Promise.resolve()),
  draftLoad: (key: string) => invoke<Draft | null>("draft_load", { key }),
  draftClear: (key: string) => (inApp ? invoke<void>("draft_clear", { key }) : Promise.resolve()),
  draftList: () => (inApp ? invoke<DraftInfo[]>("draft_list") : Promise.resolve([])),
  getRecent: () => inApp ? invoke<RecentSnapshot>("get_recent") : Promise.resolve({ revision: 0, entries: [] }),
  getFavorites: () => inApp ? invoke<FavoritesSnapshot>("get_favorites") : Promise.resolve({ revision: 0, paths: [] }),
  getWorkspaceHistory: () => inApp ? invoke<RecentSnapshot>("get_workspace_history") : Promise.resolve({ revision: 0, entries: [] }),
  updateWorkspaceHistory: (action: WorkspaceHistoryAction) => invoke<RecentSnapshot>("update_workspace_history", { action }),
  listUserTemplates: () => inApp ? invoke<UserTemplateList>("list_user_templates") : Promise.resolve({ revision: 0, templates: [] }),
  getUserTemplate: (id: string) => invoke<UserTemplate>("get_user_template", { id }),
  putUserTemplate: (input: UserTemplateInput) => invoke<UserTemplate>("put_user_template", { input }),
  deleteUserTemplate: (id: string, expectedVersion: number) => invoke<void>("delete_user_template", { id, expectedVersion }),
  readTemplateArchive: (path: string) => invoke<TemplateArchive>("read_template_archive", { path }),
  exportTemplateArchive: (outPath: string, ids: string[], expectedRevision: number) => invoke<void>("export_template_archive", { outPath, ids, expectedRevision }),
  importTemplateArchive: (entries: UserTemplateInput[]) => invoke<number>("import_template_archive", { entries }),
  setFavorite: (path: string, present: boolean) => invoke<FavoritesSnapshot>("set_favorite", { path, present }),
  moveFavorite: (path: string, direction: "up" | "down", expectedRevision: number) =>
    invoke<FavoritesSnapshot>("move_favorite", { path, direction, expectedRevision }),
  recordRecent: (path: string) => inApp ? invoke<RecentSnapshot>("record_recent", { path }) : Promise.resolve({ revision: 0, entries: [] }),
  removeRecent: (path: string) => inApp ? invoke<RecentSnapshot>("remove_recent", { path }) : Promise.resolve({ revision: 0, entries: [] }),
  clearRecent: () => inApp ? invoke<RecentSnapshot>("clear_recent") : Promise.resolve({ revision: 0, entries: [] }),
  setAssetScope: (path: string, recursive: boolean) =>
    invoke<void>("set_asset_scope", { path, recursive }),
  // 파일 감시도 앱 밖에선 대상이 없다 — 웹 모드에서 매 탭 열림마다
  // '외부 변경 감시 실패' 에러 알림이 화면에 떴다(콘솔이 아니라 UI 노이즈).
  watchPaths: (files: string[], dirs: string[]) =>
    inApp ? invoke<void>("watch_paths", { files, dirs }) : Promise.resolve(),
  exportPdf: (html: string, options: PdfOptions, outPath: string) =>
    invoke<void>("export_pdf", { html, options, outPath }),
  exportDocx: (markdown: string, manifest: DocxManifest, outPath: string, baseDir: string) =>
    invoke<void>("export_docx", { markdown, manifest, outPath, baseDir }),
  exportEpub: (
    manifest: {
      chapters: Array<{ title: string; body: string; file: string }>;
      title: string;
      author: string;
      language: string;
      css: string;
      coverPath: string | null;
      baseDir: string;
    },
    outPath: string,
  ) => invoke<void>("export_epub", { manifest, outPath }),
  writeExportFile: (path: string, contents: string) =>
    invoke<void>("write_export_file", { path, contents }),
  revealInFinder: (path: string) => invoke<void>("reveal_in_finder", { path }),
  fileRename: (from: string, to: string, root: string | null) => invoke<string[]>("file_rename", { from, to, root }),
  fileDuplicate: (path: string) => invoke<string>("file_duplicate", { path }),
  reviewDocumentTrash: (root: string, path: string) => invoke<TrashDocument>("review_document_trash", { root, path }),
  trashDocument: (reviewed: TrashDocument) => invoke<void>("trash_document", { reviewed }),
  newFileIn: (dir: string) => invoke<string>("new_file_in", { dir }),
  newFolderIn: (root: string, dir: string, name: string) => invoke<string>("new_folder_in", { root, dir, name }),
  pendingRenames: () => invoke<PendingRename[]>("pending_renames"),
  finishRenameReview: (id: number, discard = false) => invoke<void>("finish_rename_review", { id, discard }),
  previewWikiRename: (id: number) => invoke<ReplacementPreview>("preview_wiki_rename", { id }),
  openInNewWindow: (path: string) => invoke<void>("open_in_new_window", { path }),
  saveImageBytes: (dir: string, mime: string, bytes: Uint8Array) =>
    invoke<string>("save_image_bytes", bytes, {
      headers: { "x-image-directory": encodeURIComponent(dir), "x-image-type": mime },
    }),
  documentEdges: (root: string) =>
    invoke<DocumentEdge[]>("document_edges", { root }),
  inspectLinks: (root: string, source: string | null, text: string) =>
    invoke<LinkInspection>("inspect_links", { root, source, text }),
  createLinkDocument: (root: string, source: string | null, kind: MissingLink["kind"], name: string) =>
    invoke<string>("create_link_document", { root, source, kind, name }),
  findOrphanImages: (root: string, buffers: string[]) =>
    invoke<OrphanAsset[]>("find_orphan_images", { root, buffers }),
  deleteOrphanImages: (root: string, assets: OrphanAsset[], buffers: string[]) =>
    invoke<AssetTrashReport>("delete_orphan_images", { root, assets, buffers }),
  importImage: (src: string, dir: string) => invoke<string>("import_image", { src, dir }),
  docStyleGet: (path: string) => inApp ? invoke<string | null>("doc_style_get", { path }) : Promise.resolve(null),
  bookmarkList: (path: string) => invoke<BookmarkSnapshot>("bookmark_list", { path }),
  /** 문서 메모(줄 앵커 사이드카 — 원문 불변). */
  commentList: (path: string) =>
    invoke<DocComment[]>("comment_list", { path }),
  commentAdd: (path: string, lineNo: number, text: string) =>
    invoke<number>("comment_add", { path, lineNo, text }),
  commentUpdate: (path: string, id: number, text: string, expected: CommentExpectation) =>
    invoke<void>("comment_update", { path, id, text, expected }),
  commentResolve: (path: string, id: number, resolved: boolean, expected: CommentExpectation) =>
    invoke<void>("comment_resolve", { path, id, resolved, expected }),
  commentRemove: (path: string, id: number, expected: CommentExpectation) =>
    invoke<void>("comment_remove", { path, id, expected }),
  commentReanchor: (path: string, updates: Array<[number, number]>) =>
    invoke<void>("comment_reanchor", { path, updates }),
  baselineGet: (path: string) => invoke<BaselineSnapshot>("baseline_get", { path }),
  baselineWrite: (path: string, text: string | null, expected: { text: string | null }) =>
    invoke<BaselineSnapshot>("baseline_write", { path, text, expected }),
  bookmarkSet: (path: string, lineNo: number, present: boolean, expectedText: string) =>
    invoke<BookmarkSnapshot>("bookmark_set", { path, lineNo, present, expectedText }),
  bookmarkReplace: (path: string, text: string, lines: number[], expected: Pick<BookmarkSnapshot, "text" | "lines">) =>
    invoke<BookmarkSnapshot>("bookmark_replace", { path, text, lines, expected }),
  docStyleSet: (path: string, styleJson: string) =>
    inApp ? invoke<void>("doc_style_set", { path, styleJson }) : Promise.resolve(),
  docStyleClear: (path: string) => invoke<void>("doc_style_clear", { path }),
  openLogsDir: () => invoke<void>("open_logs_dir"),
};

// — 이벤트 수신 —

export interface FsEvent {
  path: string;
  kind: "changed" | "removed";
}

export type Unlisten = () => void;

// 이벤트 수신은 앱 안에서만 의미가 있다 — 웹 모드(브라우저 개발 미리보기)에서
// @tauri-apps/api/event의 listen은 __TAURI_INTERNALS__ 없이 동기 throw하고,
// 호출부(App keep)가 catch하지 않아 미처리 기각으로 콘솔을 오염시켰다. no-op 반환.
export async function onFsEvent(handler: (e: FsEvent) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<FsEvent>("fs-event", (ev) => handler(ev.payload));
}

export async function onMenu(handler: (id: string) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<string>("menu", (ev) => handler(ev.payload));
}

export async function onOpenFiles(handler: (paths: string[]) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<string[]>("open-files", (ev) => handler(ev.payload));
}

export async function onSettingsChanged(handler: (s: SettingsSnapshot) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<SettingsSnapshot>("settings-changed", (ev) => handler(ev.payload));
}

export async function onPendingRenamesChanged(handler: () => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen("pending-renames-changed", () => handler());
}

export async function onBookmarksChanged(handler: (path: string) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<string>("bookmarks-changed", (event) => handler(event.payload));
}

export async function onBaselineChanged(handler: (path: string) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<string>("baseline-changed", (event) => handler(event.payload));
}

export async function onCommentsChanged(handler: (path: string) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<string>("comments-changed", (event) => handler(event.payload));
}

export async function onRecentChanged(handler: (snapshot: RecentSnapshot) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<RecentSnapshot>("recent-changed", (event) => handler(event.payload));
}

export async function onFavoritesChanged(handler: (snapshot: FavoritesSnapshot) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<FavoritesSnapshot>("favorites-changed", (event) => handler(event.payload));
}

export async function onUserTemplatesChanged(handler: (revision: number) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<number>("user-templates-changed", (event) => handler(event.payload));
}

export async function onWorkspaceHistoryChanged(handler: (snapshot: RecentSnapshot) => void): Promise<Unlisten> {
  if (!inApp) return () => {};
  events ??= await import("@tauri-apps/api/event");
  return events.listen<RecentSnapshot>("workspace-history-changed", (event) => handler(event.payload));
}

// — 대화상자(plugin-dialog) —

export async function pickOpenFile(): Promise<string | null> {
  if (!inApp) return null;
  const dialog = await import("@tauri-apps/plugin-dialog");
  const picked = await dialog.open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  });
  return typeof picked === "string" ? picked : null;
}

export async function pickImageFile(): Promise<string | null> {
  if (!inApp) return null;
  const dialog = await import("@tauri-apps/plugin-dialog");
  const picked = await dialog.open({
    multiple: false,
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"] }],
  });
  return typeof picked === "string" ? picked : null;
}

export async function pickOpenFolder(): Promise<string | null> {
  if (!inApp) return null;
  const dialog = await import("@tauri-apps/plugin-dialog");
  const picked = await dialog.open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

export async function pickTemplateArchive(): Promise<string | null> {
  if (!inApp) return null;
  const dialog = await import("@tauri-apps/plugin-dialog");
  const picked = await dialog.open({ multiple: false, filters: [{ name: "IYAGI Templates", extensions: ["json"] }] });
  return typeof picked === "string" ? picked : null;
}

export interface SavePick {
  path: string;
}

export async function pickSave(defaultName: string, ext: string): Promise<string | null> {
  if (!inApp) return null;
  const dialog = await import("@tauri-apps/plugin-dialog");
  return (await dialog.save({
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  })) as string | null;
}

export async function askDialog(message: string, title?: string): Promise<boolean> {
  if (!inApp) return window.confirm(message);
  const dialog = await import("@tauri-apps/plugin-dialog");
  return dialog.ask(message, { title, kind: "warning" });
}

// — 창 —

export async function currentWindowApi() {
  const w = await import("@tauri-apps/api/window");
  return w.getCurrentWindow();
}

export async function webviewWindowApi() {
  const w = await import("@tauri-apps/api/webviewWindow");
  return w.getCurrentWebviewWindow();
}

/** 로컬 파일 경로를 asset 프로토콜 URL로 바꾼다(앱 안에서만 유효).
 *  @tauri-apps/api/core의 convertFileSrc와 같은 internals 경로를 쓴다(동기). */
export function convertFileSrc(path: string): string {
  if (!inApp) return path;
  const internals = (window as unknown as {
    __TAURI_INTERNALS__: { convertFileSrc: (p: string, proto: string) => string };
  }).__TAURI_INTERNALS__;
  return internals.convertFileSrc(path, "asset");
}
