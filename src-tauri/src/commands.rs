//! 프런트에서 부르는 Tauri 명령. 모든 파일 IO는 여기를 지난다 — 원문 보존
//! 원칙(§4-2)상 저장 경로는 md_core::io의 원자적 쓰기 하나뿐이다.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use md_core::io::{read_doc, write_doc_atomic, DocMeta, LoadedDoc};
use md_core::recent::RecentEntry;
use md_core::session::SessionState;
use md_core::settings::{LangSetting, Settings};
use md_core::tree::{scan_tree, TreeNode};

use crate::state::{push_recent, AppState};

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// 설정의 language 절에서 실제 메뉴 언어를 계산한다.
pub fn lang_of(settings: &Settings) -> md_core::i18n::Lang {
    match settings.language {
        LangSetting::En => md_core::i18n::Lang::En,
        LangSetting::Ko => md_core::i18n::Lang::Ko,
        LangSetting::Auto => md_core::i18n::Lang::detect(md_macos::locale::preferred_languages()),
    }
}

// — 앱 수명 —

/// 프런트가 렌더링을 마쳤다 — 창을 보여준다.
#[tauri::command]
pub fn app_ready(app: AppHandle) {
    crate::window::show_main(&app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub lang: String,
    pub log_dir: Option<String>,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let settings = app.state::<AppState>().settings.read().unwrap().clone();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        lang: lang_of(&settings).code().to_string(),
        log_dir: crate::logging::log_dir(&app).map(|p| p.to_string_lossy().into_owned()),
    }
}

/// 시작 시점에 쌓인 열기 요청을 가져간다(가져가면 비운다).
#[tauri::command]
pub fn take_pending_files(state: State<'_, AppState>) -> Vec<String> {
    let mut pending = state.pending_files.lock().unwrap();
    std::mem::take(&mut *pending)
}

// — 문서 IO —

#[tauri::command]
pub async fn read_document(app: AppHandle, path: String) -> Result<LoadedDoc, String> {
    // 파일 읽기는 스레드 풀로 — 동기 커맨드는 앱 메인 스레드에서 돌아 큰 문서를
    // 열 때 이벤트 루프가 멈춘다(스크롤·입력이 끊기는 원인).
    let doc = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || read_doc(Path::new(&path)).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())??;
    // 이미지 표시용 asset 프로토콜 허용 범위를 문서 폴더 **하위 트리**로 확장.
    // (바깥 상대 경로 ../…는 위젯의 온디맨드 허용으로 처리된다.)
    if let Some(dir) = Path::new(&path).parent() {
        let _ = app.asset_protocol_scope().allow_directory(dir, true);
    }
    push_recent(&app, &path);
    Ok(doc)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub mtime: f64,
    pub size: u64,
}

#[tauri::command]
pub async fn write_document(
    app: AppHandle,
    path: String,
    text: String,
    meta: DocMeta,
) -> Result<WriteOutcome, String> {
    let p = PathBuf::from(&path);
    // 원자적 저장도 스레드 풀로(쓰기+rename+메타데이터 조회).
    let m = tauri::async_runtime::spawn_blocking(move || {
        write_doc_atomic(&p, &text, meta).map_err(err)?;
        std::fs::metadata(&p).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::watcher::note_self_write(&app, Path::new(&path));
    push_recent(&app, &path);
    Ok(WriteOutcome {
        mtime: m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0),
        size: m.len(),
    })
}

/// 내보내기 HTML 조립용 이미지 등 바이너리 읽기(경로 제한 없음 — 샌드박스 없는
/// 앱의 최소 명령면 중 하나, §4-6).
#[tauri::command]
pub async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    // 이미지 같은 큰 바이너리 — 메인 스레드를 지키기 위해 풀로.
    tauri::async_runtime::spawn_blocking(move || std::fs::read(&path).map_err(err))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scan_workspace(root: String) -> Result<Vec<TreeNode>, String> {
    // 재귀 폴더 스캔은 수 밀리초~수 초짜리 무거운 IO — 반드시 스레드 풀에서.
    // (동기 커맨드는 앱 메인 스레드에서 돌아 폴더를 여는 동안 창이 얼어붙는다.)
    tauri::async_runtime::spawn_blocking(move || scan_tree(Path::new(&root)).map_err(err))
        .await
        .map_err(|e| e.to_string())?
}

// — 설정·세션·최근 문서 —

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let old_lang = lang_of(&app.state::<AppState>().settings.read().unwrap());
    settings
        .save(&app.state::<AppState>().paths.settings)
        .map_err(err)?;
    *app.state::<AppState>().settings.write().unwrap() = settings.clone();
    if lang_of(&settings) != old_lang {
        crate::menu::install(&app).map_err(err)?;
    }
    let _ = app.emit("settings-changed", settings);
    Ok(())
}

#[tauri::command]
pub fn get_session(state: State<'_, AppState>) -> Option<SessionState> {
    state.session.clone()
}

#[tauri::command]
pub async fn save_session(app: AppHandle, session: SessionState) -> Result<(), String> {
    // 탭 전환·열기/닫기마다(디바운스됨) 도는 저장 — 메인 스레드에서 내보낸다.
    let path = app.state::<AppState>().paths.session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        md_core::session::save(&path, &session).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_recent(state: State<'_, AppState>) -> Vec<RecentEntry> {
    state.recent.lock().unwrap().entries().to_vec()
}

#[tauri::command]
pub fn clear_recent(app: AppHandle) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let mut recent = state.recent.lock().unwrap();
        *recent = md_core::recent::RecentList::new();
        recent.save(&state.paths.recent).map_err(err)?;
    }
    crate::menu::install(&app).map_err(err)?;
    Ok(())
}

// — 에셋 범위·감시 —

/// 이미지 표시를 위해 특정 폴더(보통 워크스페이스)를 asset 프로토콜에 추가.
#[tauri::command]
pub fn set_asset_scope(app: AppHandle, path: String, recursive: bool) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_directory(Path::new(&path), recursive)
        .map_err(err)
}

#[tauri::command]
pub fn watch_paths(app: AppHandle, files: Vec<String>, dirs: Vec<String>) {
    crate::watcher::update_watch(&app, files, dirs);
}

// — 내보내기 —

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOptions {
    /// a4 | letter | a5
    pub paper: String,
    /// portrait | landscape
    pub orientation: String,
    /// 모든 방향 여백(mm).
    pub margin_mm: f64,
    /// 0.5~2.0, 본문 배율.
    pub scale: f64,
}

/// HTML을 숨은 WKWebView에서 PDF로(§4-4). 임시 파일은 만들지 않는다.
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    html: String,
    options: PdfOptions,
    out_path: String,
) -> Result<(), String> {
    crate::pdf::export_pdf(&app, html, &options, Path::new(&out_path)).await
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DocxManifest {
    /// LaTeX 원문 → MathML(KaTeX output:'mathml' 결과).
    pub math: std::collections::HashMap<String, String>,
    /// mermaid 코드 원문 → SVG(순수 벡터, foreignObject 없음).
    pub diagrams: std::collections::HashMap<String, String>,
    /// 문서별 기본 서체(라이브 프리뷰 스타일 반영).
    pub style: Option<DocxStyleSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxStyleSpec {
    pub font: String,
    #[serde(default = "default_size_pt")]
    pub size_pt: f64,
    /// 행간 배율(0 = 기본 1.15).
    #[serde(default)]
    pub line_height: f64,
    /// 문단 첫 줄 들여쓰기(한국어 문서 관례).
    #[serde(default)]
    pub first_line_indent: bool,
    /// 강조색(RRGGBB, # 없음).
    pub accent: Option<String>,
}

fn default_size_pt() -> f64 {
    11.0
}

/// 마크다운 → DOCX(comrak AST → 직접 OOXML 생성, §4-3/§4-4).
#[tauri::command]
pub fn export_docx(
    markdown: String,
    manifest: DocxManifest,
    out_path: String,
    base_dir: String,
) -> Result<(), String> {
    let images = md_export::ImageSource::new(base_dir);
    md_export::docx::export_docx(
        &markdown,
        &manifest.math,
        &manifest.diagrams,
        &images,
        Path::new(&out_path),
        manifest.style.as_ref().map(|s| {
        (
            s.font.as_str(),
            s.size_pt,
            s.line_height,
            s.first_line_indent,
            s.accent.clone().unwrap_or_default(),
        )
    }),
    )
    .map_err(err)
}

/// 프런트가 조립한 자체 완결형 HTML을 파일로(HTML 내보내기).
#[tauri::command]
pub fn write_export_file(path: String, contents: String) -> Result<(), String> {
    md_core::io::write_bytes_atomic(Path::new(&path), contents.as_bytes()).map_err(err)
}

/// 활성 문서(또는 지정 경로)를 **새 창**에서 연다(Word "새 창으로 보기").
/// 새 창은 label이 달라 세션 저장·메뉴 상태는 메인 창이 계속 소유한다.
#[tauri::command]
pub fn open_in_new_window(
    app: AppHandle,
    path: Option<String>,
) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let label = format!("doc-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0));
    let url = match &path {
        Some(p) => WebviewUrl::App(format!("index.html?file={}", urlencode(p)).into()),
        None => WebviewUrl::App("index.html".into()),
    };
    let title = path
        .as_deref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "IYAGI Markdown".to_string());
    WebviewWindowBuilder::new(&app, &label, url)
        .title(&title)
        .inner_size(900.0, 700.0)
        .min_inner_size(480.0, 360.0)
        .build()
        .map(|_| ())
        .map_err(err)
}

/// 경로 trivial 인코딩(쿼리 파라미터용).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// — 시스템 연동 —

#[tauri::command]
pub fn reveal_in_finder(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(Path::new(&path))
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
pub fn open_logs_dir(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if let Some(dir) = crate::logging::log_dir(&app) {
        std::fs::create_dir_all(&dir).map_err(err)?;
        app.opener()
            .reveal_item_in_dir(&dir)
            .map(|_| ())
            .map_err(err)
    } else {
        Err("로그 디렉터리를 알 수 없습니다".into())
    }
}
