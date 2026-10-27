//! 프런트에서 부르는 Tauri 명령. 모든 파일 IO는 여기를 지난다 — 원문 보존
//! 원칙(§4-2)상 저장 경로는 md_core::io의 원자적 쓰기 하나뿐이다.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use md_core::io::{read_doc, write_doc_checked, DocError, DocMeta, LoadedDoc, WriteExpectation};
use md_core::recent::RecentSnapshot;
use md_core::session::SessionState;
use md_core::settings::{LangSetting, Settings};
use md_core::tree::{scan_tree, WorkspaceScan};

use crate::state::{update_recent, AppState};

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

/// 프런트 오류 경계의 크래시 기록 — 로그 파일에 남겨 보고·사후 진단.
#[tauri::command]
pub fn log_error(message: String) {
    tracing::error!(target: "frontend", "{}", message);
}

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
    Ok(doc)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub mtime: f64,
    pub size: u64,
}

#[derive(Serialize)]
pub struct WriteFailure {
    code: &'static str,
    message: String,
}

impl WriteFailure {
    fn io(error: impl std::fmt::Display) -> Self {
        Self {
            code: "io",
            message: error.to_string(),
        }
    }
}

impl From<DocError> for WriteFailure {
    fn from(error: DocError) -> Self {
        let code = match &error {
            DocError::Conflict { removed: true, .. } => "removed",
            DocError::Conflict { .. } => "conflict",
            _ => "io",
        };
        Self {
            code,
            message: error.to_string(),
        }
    }
}

#[tauri::command]
pub async fn write_document(
    app: AppHandle,
    path: String,
    text: String,
    meta: DocMeta,
    expected: WriteExpectation,
) -> Result<WriteOutcome, WriteFailure> {
    let p = PathBuf::from(&path);
    let data_dir = app.path().app_data_dir().map_err(WriteFailure::io)?;
    let doc_path = path.clone();
    // 원자적 저장도 스레드 풀로(쓰기+rename+메타데이터 조회).
    let m = tauri::async_runtime::spawn_blocking(move || {
        // 교체될 내용을 먼저 버전 기록으로 남긴다(Obsidian file recovery식) —
        // 실패해도 저장 자체는 계속된다(원칙: 스냅숏은 부가 기능).
        if let Ok(bytes) = std::fs::read(&p) {
            let old = String::from_utf8_lossy(&bytes).into_owned();
            if old != text {
                let _ = md_core::snapshots::save_snapshot(&data_dir, &doc_path, &old);
            }
        }
        write_doc_checked(&p, &text, meta, &expected).map_err(WriteFailure::from)?;
        std::fs::metadata(&p).map_err(WriteFailure::io)
    })
    .await
    .map_err(WriteFailure::io)??;
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

/// EPUB 내보내기 — 본문 XHTML·CSS는 프런트가, 조립·zip은 md-export가.
#[tauri::command]
pub async fn export_epub(manifest: EpubManifest, out_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if manifest.chapters.is_empty() {
            return Err("EPUB: 챕터가 없습니다".into());
        }
        let opts = md_export::epub::EpubOptions {
            title: manifest.title,
            author: manifest.author,
            language: manifest.language,
            css: manifest.css,
            cover_path: manifest.cover_path,
            base_dir: manifest.base_dir,
            chapters: manifest.chapters,
        };
        md_export::epub::export_epub(&opts, std::path::Path::new(&out_path))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// EPUB 내보내기 매개변수(프런트가 조립).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubManifest {
    pub chapters: Vec<md_export::epub::EpubChapter>,
    pub title: String,
    pub author: String,
    pub language: String,
    pub css: String,
    pub cover_path: Option<String>,
    pub base_dir: String,
}

// — 소리내어 읽기(macOS say, 시스템 목소리 — 의존 0) —

static SPEAKER: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

/// 텍스트를 시스템 목소리로 읽는다. 진행 중이면 먼저 끊는다. 실패는 조용히
/// (say 없는 환경) — 반환값은 시작 성공 여부.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInfo {
    pub name: String,
    /// BCP 언어 태그(ko_KR 등).
    pub lang: String,
}

/// 시스템 목소리 목록(say -v '?') — 이름·언어만.
#[tauri::command]
pub async fn list_voices() -> Result<Vec<VoiceInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let out = std::process::Command::new("say")
            .arg("-v")
            .arg("?")
            .output()
            .map_err(err)?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let mut voices = Vec::new();
        for line in text.lines() {
            // "Yuna              ko_KR  # /path" — 이름은 공백 포함 가능, 2+ 공백 구분.
            let trimmed = line.trim_end();
            let Some((head, rest)) = trimmed.split_once("  ") else {
                continue;
            };
            let lang = rest.split_whitespace().next().unwrap_or("");
            if lang.chars().next().is_some_and(|c| c.is_ascii_lowercase()) && lang.contains('_') {
                voices.push(VoiceInfo {
                    name: head.trim().to_string(),
                    lang: lang.to_string(),
                });
            }
        }
        Ok(voices)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn speak_start(text: String, rate: u32, voice: String) -> bool {
    {
        let mut g = SPEAKER.lock().unwrap();
        if let Some(mut child) = g.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let mut cmd = std::process::Command::new("say");
    cmd.arg("-r").arg(rate.to_string());
    if !voice.trim().is_empty() {
        cmd.arg("-v").arg(voice.trim());
    }
    match cmd
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(mut child) => {
            if let Some(stdin) = child.stdin.as_mut() {
                use std::io::Write;
                let _ = stdin.write_all(text.as_bytes());
            }
            // stdin을 닫아야 say가 끝을 안다.
            drop(child.stdin.take());
            *SPEAKER.lock().unwrap() = Some(child);
            true
        }
        Err(_) => false,
    }
}

/// 읽는 중인가(완료된 자식은 정리하고 false).
#[tauri::command]
pub fn speak_status() -> bool {
    let mut g = SPEAKER.lock().unwrap();
    if let Some(child) = g.as_mut() {
        match child.try_wait() {
            Ok(Some(_)) => {
                let done = g.take();
                if let Some(mut c) = done {
                    let _ = c.wait();
                }
                false
            }
            Ok(None) => true,
            Err(_) => false,
        }
    } else {
        false
    }
}

/// 읽기 중지.
#[tauri::command]
pub fn speak_stop() {
    let mut g = SPEAKER.lock().unwrap();
    if let Some(mut child) = g.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// 백링크 — 현재 문서를 [[이름]]으로 참조하는 문서들(전체 검색과 같은 풀).
#[tauri::command]
pub async fn backlinks(
    root: String,
    path: String,
) -> Result<Vec<md_core::search::SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        md_core::search::find_backlinks(Path::new(&root), &path, 200).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

// — 버전 기록(스냅숏 사이드카) —

#[tauri::command]
pub async fn snapshot_list(
    app: AppHandle,
    path: String,
) -> Result<Vec<md_core::snapshots::SnapshotInfo>, String> {
    let dir = app.path().app_data_dir().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || {
        md_core::snapshots::list_snapshots(&dir, &path).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn snapshot_read(app: AppHandle, path: String, ts: u64) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || {
        md_core::snapshots::read_snapshot(&dir, &path, ts).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 복원 직전의 편집 버퍼도 일반 저장 간격과 무관하게 보존한다.
#[tauri::command]
pub async fn snapshot_backup(app: AppHandle, path: String, text: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(err)?;
    tauri::async_runtime::spawn_blocking(move || {
        md_core::snapshots::save_before_bulk(&dir, &path, &text).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
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
pub async fn scan_workspace(root: String) -> Result<WorkspaceScan, String> {
    // 재귀 폴더 스캔은 수 밀리초~수 초짜리 무거운 IO — 반드시 스레드 풀에서.
    // (동기 커맨드는 앱 메인 스레드에서 돌아 폴더를 여는 동안 창이 얼어붙는다.)
    tauri::async_runtime::spawn_blocking(move || scan_tree(Path::new(&root)).map_err(err))
        .await
        .map_err(|e| e.to_string())?
}

/// 워크스페이스 전체 텍스트 검색 — 파일 전체를 읽는 무거운 IO라 같은 이유로
/// 스레드 풀에서(4차 교훈과 동일한 패턴).
#[tauri::command]
pub async fn search_workspace(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
) -> Result<md_core::search::SearchReport, String> {
    if query.trim().is_empty() {
        return Ok(md_core::search::SearchReport::default());
    }
    tauri::async_runtime::spawn_blocking(move || {
        md_core::search::search_report(
            Path::new(&root),
            &query,
            2000,
            case_sensitive.unwrap_or(false),
        )
        .map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

// — 설정·세션·최근 문서 —

#[derive(Clone, Serialize)]
pub struct SettingsSnapshot {
    revision: u64,
    settings: Settings,
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<SettingsSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let settings = state.settings.read().unwrap();
        SettingsSnapshot {
            revision: state
                .settings_revision
                .load(std::sync::atomic::Ordering::Relaxed),
            settings: settings.clone(),
        }
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn patch_settings(
    app: AppHandle,
    patch: serde_json::Value,
) -> Result<SettingsSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (snapshot, language_changed, changed) = {
            // 최신 설정 병합·원자적 저장·메모리 반영을 같은 잠금으로 직렬화한다.
            let mut current = state.settings.write().unwrap();
            let next = current.patched(&patch)?;
            let changed = *current != next;
            let language_changed = current.language != next.language;
            if changed {
                next.save(&state.paths.settings).map_err(err)?;
                *current = next;
                state
                    .settings_revision
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            (
                SettingsSnapshot {
                    revision: state
                        .settings_revision
                        .load(std::sync::atomic::Ordering::Relaxed),
                    settings: current.clone(),
                },
                language_changed,
                changed,
            )
        };
        if changed {
            if let Err(error) = app.emit("settings-changed", &snapshot) {
                tracing::warn!("설정 변경 알림 실패: {error}");
            }
        }
        if language_changed {
            let menu_app = app.clone();
            if let Err(error) = app.run_on_main_thread(move || {
                if let Err(error) = crate::menu::install(&menu_app) {
                    tracing::warn!("설정은 저장했지만 메뉴 갱신 실패: {error}");
                }
            }) {
                tracing::warn!("설정 메뉴 갱신 예약 실패: {error}");
            }
        }
        Ok(snapshot)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub fn get_session(state: State<'_, AppState>) -> Option<SessionState> {
    state.session.lock().unwrap().clone()
}

#[tauri::command]
pub async fn save_session(
    app: AppHandle,
    window: tauri::WebviewWindow,
    session: SessionState,
) -> Result<(), String> {
    // 탭 전환·열기/닫기마다(디바운스됨) 도는 저장 — 메인 스레드에서 내보낸다.
    let from_main = window.label() == "main";
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        // 잠금을 쥔 채 메모리·파일을 함께 갱신 — 저장 순서가 곧 반영 순서.
        let mut cur = st.session.lock().unwrap();
        let Some(next) = md_core::session::merge_from_window(cur.as_ref(), session, from_main)
        else {
            return Ok(());
        };
        // 파일 쓰기가 실패해도 메모리는 최신으로(리로드 복원은 이것을 본다).
        *cur = Some(next.clone());
        md_core::session::save(&st.paths.session, &next).map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_recent(state: State<'_, AppState>) -> RecentSnapshot {
    state.recent.lock().unwrap().snapshot()
}

#[tauri::command]
pub async fn record_recent(app: AppHandle, path: String) -> Result<RecentSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_recent(&app, |list| {
            list.push(&path);
        })
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn remove_recent(app: AppHandle, path: String) -> Result<RecentSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || update_recent(&app, |list| list.remove(&path)))
        .await
        .map_err(err)?
}

#[tauri::command]
pub async fn clear_recent(app: AppHandle) -> Result<RecentSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        update_recent(&app, |list| *list = md_core::recent::RecentList::new())
    })
    .await
    .map_err(err)?
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
pub fn watch_paths(
    app: AppHandle,
    window: tauri::WebviewWindow,
    files: Vec<String>,
    dirs: Vec<String>,
) -> Result<(), String> {
    crate::watcher::update_watch(&app, window.label().to_string(), files, dirs)
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
    /// 페이지 번호 하단 중앙(N / M) — CoreGraphics 오버레이.
    #[serde(default)]
    pub page_numbers: bool,
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
    /// 문서별 이미지 폭(%) — 마크다운 src 키(사이드카 imageWidths).
    #[serde(default)]
    pub image_widths: std::collections::HashMap<String, u32>,
    /// 문서별 표 열 폭(px) — 헤더 내용 키(사이드카 tableWidths).
    #[serde(default)]
    pub table_widths: std::collections::HashMap<String, Vec<u32>>,
    /// 프런트매터 메타 — core.xml.
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    /// 네이티브 목차(TOC 필드) 삽입 — 프런트매터 toc: true.
    #[serde(default)]
    pub toc: bool,
    /// 그림 목차 / 표 목차 — 프런트매터 lof/lot.
    #[serde(default)]
    pub lof: bool,
    #[serde(default)]
    pub lot: bool,
    /// 문서 메모(줄 앵커) — Word 원생 메모로 내보냄.
    #[serde(default)]
    pub comments: Vec<(u32, String)>,
    /// 목차 라벨 언어("ko"/"en").
    #[serde(default)]
    pub front_lang: String,
    #[serde(default)]
    pub columns: u32,
    #[serde(default)]
    pub footer_text: Option<String>,
    /// 머리글 문서 제목(Some이면 매 페이지 상단).
    #[serde(default)]
    pub header_title: Option<String>,
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
    /// 문단 정렬(left|center|right|justify) — docDefaults의 jc로.
    #[serde(default)]
    pub text_align: Option<String>,
    /// 바닥글 페이지 번호(현재 / 전체, 가운데 9pt 회색).
    #[serde(default)]
    pub page_numbers: bool,
    /// 형광펜 색(RRGGBB — 없으면 기본 노랑).
    #[serde(default)]
    pub highlight: Option<String>,
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
    let mut images = md_export::ImageSource::new(base_dir);
    images.set_widths(manifest.image_widths);
    md_export::docx::export_docx(
        &markdown,
        &md_export::docx::DocxExportOptions {
            math: &manifest.math,
            diagrams: &manifest.diagrams,
            images: &images,
            style: manifest.style.as_ref().map(|s| {
                (
                    s.font.as_str(),
                    s.size_pt,
                    s.line_height,
                    s.first_line_indent,
                    s.accent.clone().unwrap_or_default(),
                    s.text_align.clone().unwrap_or_default(),
                )
            }),
            page_numbers: manifest.style.as_ref().is_some_and(|s| s.page_numbers),
            table_widths: &manifest.table_widths,
            title: manifest.title.as_deref(),
            author: manifest.author.as_deref(),
            toc: manifest.toc,
            lof: manifest.lof,
            lot: manifest.lot,
            header_title: manifest.header_title.as_deref(),
            highlight: manifest.style.as_ref().and_then(|s| s.highlight.as_deref()),
            comments: &manifest.comments,
            front_lang: manifest.front_lang.as_str(),
            columns: manifest.columns,
            footer_text: manifest.footer_text.as_deref(),
        },
        Path::new(&out_path),
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
pub fn open_in_new_window(app: AppHandle, path: Option<String>) -> Result<(), String> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    crate::quit::cancel(&app);
    let label = format!(
        "doc-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    );
    let url = match &path {
        Some(p) => WebviewUrl::App(format!("index.html?file={}", urlencode(p)).into()),
        None => WebviewUrl::App("index.html".into()),
    };
    let title = path
        .as_deref()
        .and_then(|p| std::path::Path::new(p).file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "IYAGI Markdown".to_string());
    let mut builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(&title)
        .inner_size(900.0, 700.0)
        .min_inner_size(480.0, 360.0);
    // 직전 보조 창 위치·크기가 세션에 있으면 재사용(창 관례 — 같은 자리에).
    let session = app.try_state::<crate::state::AppState>().and_then(|st| {
        let s = st.session.lock().unwrap().clone();
        s
    });
    if let Some(session) = session {
        if let Some(rect) = session.aux_window {
            builder = builder
                .position(rect.x, rect.y)
                .inner_size(rect.width, rect.height);
        }
    }
    builder.build().map(|_| ()).map_err(err)
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

/// 워크스페이스 문서 간선(출발 경로 → 대상 경로).
#[tauri::command]
pub async fn document_edges(root: String) -> Result<Vec<md_core::search::DocumentEdge>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        md_core::search::extract_document_edges(std::path::Path::new(&root)).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn inspect_links(
    root: String,
    source: Option<String>,
    text: String,
) -> Result<md_core::broken_links::Report, String> {
    tauri::async_runtime::spawn_blocking(move || {
        md_core::broken_links::inspect(Path::new(&root), source.as_deref().map(Path::new), &text)
            .map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn create_link_document(
    root: String,
    source: Option<String>,
    kind: md_core::broken_links::Kind,
    name: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        md_core::broken_links::create(
            Path::new(&root),
            source.as_deref().map(Path::new),
            kind,
            &name,
        )
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(err)
    })
    .await
    .map_err(err)?
}

fn asset_reference_texts(app: &AppHandle, mut buffers: Vec<String>) -> Result<Vec<String>, String> {
    let used = buffers
        .iter()
        .try_fold(0usize, |sum, text| sum.checked_add(text.len()))
        .ok_or("Document buffers exceed the image cleanup scan limit")?;
    let remaining = md_core::assets::MAX_TEXT_BYTES
        .checked_sub(used)
        .ok_or("Document buffers exceed the image cleanup scan limit")?;
    let state = app.state::<AppState>();
    let drafts = state
        .draft_db
        .as_ref()
        .ok_or("Recovery drafts are unavailable; cleanup was not performed")?;
    buffers.extend(drafts.asset_reference_texts(remaining)?);
    Ok(buffers)
}

/// 워크스페이스의 이미지 정리 후보. 편집 버퍼·복구 초안의 참조도 보존한다.
#[tauri::command]
pub async fn find_orphan_images(
    app: AppHandle,
    root: String,
    buffers: Vec<String>,
) -> Result<Vec<md_core::assets::OrphanAsset>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let texts = asset_reference_texts(&app, buffers)?;
        md_core::assets::find_orphan_assets(std::path::Path::new(&root), &texts).map_err(err)
    })
    .await
    .map_err(err)?
}

/// 검토한 이미지 재확인 후 휴지통 이동. 실패를 영구 삭제로 대체하지 않는다.
#[tauri::command]
pub async fn delete_orphan_images(
    app: AppHandle,
    root: String,
    assets: Vec<md_core::assets::OrphanAsset>,
    buffers: Vec<String>,
) -> Result<md_core::assets::TrashReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if app.webview_windows().len() != 1 {
            return Err("ASSET_CLEANUP_OTHER_WINDOWS".into());
        }
        // 디스크 검사·이동 중 앱 내부 문서 저장을 직렬화한다.
        let _guard = md_core::io::document_write_guard();
        let texts = asset_reference_texts(&app, buffers)?;
        md_core::assets::trash_reviewed(std::path::Path::new(&root), &assets, &texts, |path| {
            if app.webview_windows().len() != 1 {
                return Err("ASSET_CLEANUP_OTHER_WINDOWS".into());
            }
            if md_macos::trash::move_to_trash(path) {
                Ok(())
            } else {
                Err("Could not move this file to Trash; the file was kept".into())
            }
        })
        .map_err(err)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save the exact image captured by the paste event; raw IPC avoids JSON byte arrays.
#[tauri::command]
pub async fn save_image_bytes(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected raw image bytes".into());
    };
    if bytes.is_empty() || bytes.len() > md_core::images::MAX_IMAGE_BYTES {
        return Err("Image must contain between 1 byte and 32 MiB".into());
    }
    let header = |name: &str| -> Result<String, String> {
        request
            .headers()
            .get(name)
            .ok_or_else(|| format!("Missing header: {name}"))?
            .to_str()
            .map(str::to_owned)
            .map_err(|e| e.to_string())
    };
    let encoded_dir = header("x-image-directory")?;
    if encoded_dir.len() > 16_384 {
        return Err("Image directory is too long".into());
    }
    let dir = md_core::links::percent_decode(&encoded_dir);
    let ext = md_core::images::clipboard_extension(&header("x-image-type")?)
        .ok_or_else(|| "Unsupported clipboard image type".to_string())?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let out = md_core::images::save_bytes(Path::new(&dir), "paste", ext, &bytes)?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 드래그 앤 드롭 이미지 — 문서 폴더 assets/ 로 복사해 삽입 참조를 돌려준다
/// (붙여넣기 이미지와 같은 규약). 원본은 건드리지 않고 복사만.
#[tauri::command]
pub async fn import_image(src: String, dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let out =
            md_core::images::import_file(std::path::Path::new(&src), std::path::Path::new(&dir))?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
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

/// 파일 이름 변경 — 대상이 이미 있으면 실패(덮어쓰기 없음). 같은 폴더 안 이동.
#[tauri::command]
pub async fn file_rename(
    app: AppHandle,
    from: String,
    to: String,
    root: Option<String>,
) -> Result<Vec<String>, String> {
    let worker_app = app.clone();
    let warnings = tauri::async_runtime::spawn_blocking(move || {
        use std::ffi::CString;
        let from_p = std::path::PathBuf::from(&from);
        let to_p = std::path::PathBuf::from(&to);
        if !from_p.is_file() {
            return Err("원본 파일이 없습니다".to_string());
        }
        if from_p.parent() != to_p.parent() {
            return Err("이름 변경은 같은 폴더 안에서만 가능합니다".to_string());
        }
        let old = CString::new(from.as_bytes()).map_err(err)?;
        let new = CString::new(to.as_bytes()).map_err(err)?;
        let _operation = crate::rename_jobs::operation_guard();
        let state = worker_app.state::<AppState>();
        let mut warnings = Vec::new();
        {
            let _files = md_core::io::document_write_guard();
            // 먼저 기록을 확정한다. 기록 실패 시 원본 이름을 바꾸지 않는다.
            let recovery_root = root
                .as_deref()
                .unwrap_or_else(|| from_p.parent().and_then(|p| p.to_str()).unwrap_or("/"));
            let db = state
                .style_db
                .as_ref()
                .ok_or("Rename recovery storage is unavailable")?;
            let job_id = db.prepare_rename_job(recovery_root, &from, &to)?;
            // 대상이 생겨도 덮어쓰지 않는 macOS 원자 연산.
            let result = unsafe { libc::renamex_np(old.as_ptr(), new.as_ptr(), libc::RENAME_EXCL) };
            if result != 0 {
                let mut error = std::io::Error::last_os_error().to_string();
                if let Err(cleanup) = db.remove_rename_job(job_id) {
                    error.push_str(&format!("; recovery record kept: {cleanup}"));
                }
                crate::rename_jobs::changed(&worker_app);
                return Err(error);
            }
            if let Err(error) = db.mark_rename_ready(job_id) {
                warnings.push(format!(
                    "File renamed; the saved recovery record needs to be reloaded: {error}"
                ));
            }
        }
        if let Some(db) = &state.style_db {
            if let Err(e) = db.rename_document(&from, &to) {
                warnings.push(format!(
                    "File renamed; document metadata remains at {from}: {e}"
                ));
            } else {
                crate::favorites::changed(&worker_app);
            }
        }
        if let Some(db) = &state.draft_db {
            if let Err(e) = db.rename_document(&from, &to) {
                warnings.push(format!(
                    "File renamed; recovery draft remains at {from}: {e}"
                ));
            }
        }
        match worker_app.path().app_data_dir() {
            Ok(dir) => {
                if let Err(e) = md_core::snapshots::copy_history(&dir, &from, &to) {
                    warnings.push(format!(
                        "File renamed; some version history remains at {from}: {e}"
                    ));
                }
            }
            Err(e) => warnings.push(format!(
                "File renamed; version history could not be moved: {e}"
            )),
        }
        if let Err(error) = update_recent(&worker_app, |list| {
            list.remove(&from);
            list.push(&to);
        }) {
            warnings.push(format!(
                "File renamed; recent documents could not be updated: {error}"
            ));
        }
        crate::rename_jobs::changed(&worker_app);
        Ok(warnings)
    })
    .await
    .map_err(err)??;
    Ok(warnings)
}

/// 휴지통 이동 확인 화면에 표시할 문서의 파일 정체성.
#[tauri::command]
pub async fn review_document_trash(
    root: String,
    path: String,
) -> Result<md_core::document_trash::TrashDocument, md_core::document_trash::TrashError> {
    tauri::async_runtime::spawn_blocking(move || {
        md_core::document_trash::review(Path::new(&root), Path::new(&path))
    })
    .await
    .map_err(|error| md_core::document_trash::TrashError::Io(error.to_string()))?
}

#[tauri::command]
pub async fn trash_document(
    app: AppHandle,
    reviewed: md_core::document_trash::TrashDocument,
) -> Result<(), md_core::document_trash::TrashError> {
    use md_core::document_trash::TrashError;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = md_core::io::document_write_guard();
        md_core::document_trash::apply(&reviewed, |path| {
            if app.webview_windows().len() != 1 {
                return Err(TrashError::OtherWindows);
            }
            if md_macos::trash::move_to_trash(path) {
                Ok(())
            } else {
                Err(TrashError::Io(
                    "Could not move the document to Trash".into(),
                ))
            }
        })
    })
    .await
    .map_err(|error| TrashError::Io(error.to_string()))?
}

/// 파일 복제 — '이름 2.md'부터 빈 슬롯을 찾아 복사. 새 경로 반환.
#[tauri::command]
pub async fn file_duplicate(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        md_core::document_files::duplicate_document(Path::new(&path))
            .map_err(err)?
            .into_os_string()
            .into_string()
            .map_err(|_| "Unsupported path encoding".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 워크스페이스 안에 표시 가능한 새 폴더 하나를 만든다.
#[tauri::command]
pub async fn new_folder_in(
    root: String,
    dir: String,
    name: String,
) -> Result<String, md_core::tree::CreateFolderError> {
    tauri::async_runtime::spawn_blocking(move || {
        md_core::tree::create_folder(Path::new(&root), Path::new(&dir), &name)
    })
    .await
    .map_err(|error| md_core::tree::CreateFolderError::Io(error.to_string()))?
}

/// 언어 설정에 맞는 기본 이름으로 빈 문서를 생성하고 경로를 반환한다.
#[tauri::command]
pub async fn new_file_in(app: AppHandle, dir: String) -> Result<String, String> {
    let settings = app.state::<AppState>().settings.read().unwrap().clone();
    let language = lang_of(&settings);
    tauri::async_runtime::spawn_blocking(move || {
        md_core::document_files::create_document(Path::new(&dir), language)
            .map_err(err)?
            .into_os_string()
            .into_string()
            .map_err(|_| "Unsupported path encoding".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
