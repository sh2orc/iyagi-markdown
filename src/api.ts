// Tauri 명령 래퍼. 브라우저(vite dev 단독)에서는 안전하게 실패한다 —
// 순수 로직 모듈(store·links 등)은 이 파일을 import하지 않고,
// 컴포넌트/App 레벨에서만 쓴다(단위 테스트 가능성 유지).

export interface DocMeta {
  hadBom: boolean;
  crlf: boolean;
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

export interface TreeNode {
  kind: "dir" | "file";
  name: string;
  path: string;
  stem?: string;
  children?: TreeNode[];
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
  /** TTS 읽기 속도(기준 175). */
  ttsRate: number;
  /** 스마트 문장부호 — 입력 시 문맥 변환(Word 자동 교정). */
  smartPunctuation: boolean;
  /** 긴 문장(60자+) 점선 밑줄 — 작가 보조. */
  longSentenceMarks: boolean;
  /** 긴 문장 임계값(자). */
  longSentenceMin: number;
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

export interface SessionTab {
  path: string | null;
  mode: "edit" | "read" | "source";
  cursor: number;
  scroll: number;
}

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

/** 워크스페이스 전체 검색 결과(줄 조각) — Rust search_tree와 같은 모양. */
export interface SearchHit {
  path: string;
  /** 1부터 시작. */
  lineNo: number;
  line: string;
}

/** 버전 기록 스냅숏(저장이 교체한 이전 상태) — Rust snapshots.rs와 같은 모양. */
export interface SnapshotInfo {
  /** 에포크 밀리초. */
  ts: number;
  size: number;
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
  style?: { font: "system" | "serif" | "round" | "mono"; sizePt: number };
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

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inApp) throw new Error(`이 명령은 앱 안에서만 쓸 수 있습니다: ${cmd}`);
  tauri ??= await import("@tauri-apps/api/core");
  return tauri.invoke<T>(cmd, args);
}

export const api = {
  appReady: () => invoke<void>("app_ready"),
  appInfo: () => invoke<AppInfo>("app_info"),
  takePendingFiles: () => invoke<string[]>("take_pending_files"),
  readDocument: (path: string) => invoke<LoadedDoc>("read_document", { path }),
  writeDocument: (path: string, text: string, meta: DocMeta) =>
    invoke<WriteOutcome>("write_document", { path, text, meta }),
  readFileBytes: (path: string) => invoke<number[]>("read_file_bytes", { path }),
  scanWorkspace: (root: string) => invoke<TreeNode[]>("scan_workspace", { root }),
  searchWorkspace: (root: string, query: string) =>
    invoke<SearchHit[]>("search_workspace", { root, query }),
  replaceWorkspace: (root: string, needle: string, replacement: string, caseSensitive: boolean) =>
    invoke<Array<{ path: string; count: number }>>("replace_workspace", {
      root,
      needle,
      replacement,
      caseSensitive,
    }),
  snapshotList: (path: string) => invoke<SnapshotInfo[]>("snapshot_list", { path }),
  backlinks: (root: string, path: string) =>
    invoke<SearchHit[]>("backlinks", { root, path }),
  speakStart: (text: string, rate: number, voice: string) =>
    invoke<boolean>("speak_start", { text, rate, voice }),
  listVoices: () => invoke<Array<{ name: string; lang: string }>>("list_voices"),
  speakStop: () => invoke<void>("speak_stop"),
  speakStatus: () => invoke<boolean>("speak_status"),
  snapshotRead: (path: string, ts: number) => invoke<string>("snapshot_read", { path, ts }),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),
  getSession: () => invoke<SessionState | null>("get_session"),
  saveSession: (session: SessionState) => invoke<void>("save_session", { session }),
  getRecent: () => invoke<RecentEntry[]>("get_recent"),
  clearRecent: () => invoke<void>("clear_recent"),
  setAssetScope: (path: string, recursive: boolean) =>
    invoke<void>("set_asset_scope", { path, recursive }),
  watchPaths: (files: string[], dirs: string[]) => invoke<void>("watch_paths", { files, dirs }),
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
  fileRename: (from: string, to: string) => invoke<void>("file_rename", { from, to }),
  fileDuplicate: (path: string) => invoke<string>("file_duplicate", { path }),
  newFileIn: (dir: string) => invoke<string>("new_file_in", { dir }),
  updateWikiLinks: (root: string, from: string, to: string) =>
    invoke<number>("update_wiki_links", { root, from, to }),
  openInNewWindow: (path: string) => invoke<void>("open_in_new_window", { path }),
  saveClipboardImage: (dir: string) => invoke<string>("save_clipboard_image", { dir }),
  wikiEdges: (root: string) =>
    invoke<Array<{ from: string; to: string }>>("wiki_edges", { root }),
  findOrphanImages: (root: string) =>
    invoke<Array<{ path: string; size: number }>>("find_orphan_images", { root }),
  deleteOrphanImages: (paths: string[]) =>
    invoke<number>("delete_orphan_images", { paths }),
  importImage: (src: string, dir: string) => invoke<string>("import_image", { src, dir }),
  docStyleGet: (path: string) => invoke<string | null>("doc_style_get", { path }),
  bookmarkList: (path: string) => invoke<number[]>("bookmark_list", { path }),
  /** 문서 메모(줄 앵커 사이드카 — 원문 불변). */
  commentList: (path: string) =>
    invoke<Array<{ id: number; lineNo: number; text: string; createdAt: number; resolved: boolean }>>("comment_list", { path }),
  commentAdd: (path: string, lineNo: number, text: string) =>
    invoke<number>("comment_add", { path, lineNo, text }),
  commentUpdate: (id: number, text: string) => invoke<void>("comment_update", { id, text }),
  commentResolve: (id: number, resolved: boolean) => invoke<void>("comment_resolve", { id, resolved }),
  commentRemove: (id: number) => invoke<void>("comment_remove", { id }),
  commentReanchor: (path: string, updates: Array<[number, number]>) =>
    invoke<void>("comment_reanchor", { path, updates }),
  baselineGet: (path: string) => invoke<string | null>("baseline_get", { path }),
  baselineSet: (path: string, text: string) => invoke<void>("baseline_set", { path, text }),
  baselineClear: (path: string) => invoke<void>("baseline_clear", { path }),
  bookmarkAdd: (path: string, lineNo: number) => invoke<void>("bookmark_add", { path, lineNo }),
  bookmarkRemove: (path: string, lineNo: number) => invoke<void>("bookmark_remove", { path, lineNo }),
  docStyleSet: (path: string, styleJson: string) =>
    invoke<void>("doc_style_set", { path, styleJson }),
  docStyleClear: (path: string) => invoke<void>("doc_style_clear", { path }),
  openLogsDir: () => invoke<void>("open_logs_dir"),
};

// — 이벤트 수신 —

export interface FsEvent {
  path: string;
  kind: "changed" | "removed";
}

export type Unlisten = () => void;

export async function onFsEvent(handler: (e: FsEvent) => void): Promise<Unlisten> {
  events ??= await import("@tauri-apps/api/event");
  return events.listen<FsEvent>("fs-event", (ev) => handler(ev.payload));
}

export async function onMenu(handler: (id: string) => void): Promise<Unlisten> {
  events ??= await import("@tauri-apps/api/event");
  return events.listen<string>("menu", (ev) => handler(ev.payload));
}

export async function onOpenFiles(handler: (paths: string[]) => void): Promise<Unlisten> {
  events ??= await import("@tauri-apps/api/event");
  return events.listen<string[]>("open-files", (ev) => handler(ev.payload));
}

export async function onSettingsChanged(handler: (s: Settings) => void): Promise<Unlisten> {
  events ??= await import("@tauri-apps/api/event");
  return events.listen<Settings>("settings-changed", (ev) => handler(ev.payload));
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
