//! 프런트에서 부르는 Tauri 명령. 모든 파일 IO는 여기를 지난다 — 원문 보존
//! 원칙(§4-2)상 저장 경로는 md_core::io의 원자적 쓰기 하나뿐이다.

use std::path::Path;

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
pub fn read_document(app: AppHandle, path: String) -> Result<LoadedDoc, String> {
    let p = Path::new(&path);
    let doc = read_doc(p).map_err(err)?;
    // 이미지 표시용 asset 프로토콜 허용 범위를 문서 폴더 **하위 트리**로 확장.
    // (바깥 상대 경로 ../…는 위젯의 온디맨드 허용으로 처리된다.)
    if let Some(dir) = p.parent() {
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
pub fn write_document(
    app: AppHandle,
    path: String,
    text: String,
    meta: DocMeta,
) -> Result<WriteOutcome, String> {
    let p = Path::new(&path);
    write_doc_atomic(p, &text, meta).map_err(err)?;
    crate::watcher::note_self_write(&app, p);
    let m = std::fs::metadata(p).map_err(err)?;
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
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(err)
}

#[tauri::command]
pub fn scan_workspace(root: String) -> Result<Vec<TreeNode>, String> {
    scan_tree(Path::new(&root)).map_err(err)
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
pub fn save_session(state: State<'_, AppState>, session: SessionState) -> Result<(), String> {
    md_core::session::save(&state.paths.session, &session).map_err(err)
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
        manifest.style.as_ref().map(|s| (s.font.as_str(), s.size_pt)),
    )
    .map_err(err)
}

/// 프런트가 조립한 자체 완결형 HTML을 파일로(HTML 내보내기).
#[tauri::command]
pub fn write_export_file(path: String, contents: String) -> Result<(), String> {
    md_core::io::write_bytes_atomic(Path::new(&path), contents.as_bytes()).map_err(err)
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
