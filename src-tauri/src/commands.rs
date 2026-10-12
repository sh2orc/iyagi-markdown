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
    let data_dir = app.path().app_data_dir().map_err(err)?;
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
    tauri::async_runtime::spawn_blocking(move || Ok(md_core::snapshots::list_snapshots(&dir, &path)))
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

/// 워크스페이스 전체 텍스트 검색 — 파일 전체를 읽는 무거운 IO라 같은 이유로
/// 스레드 풀에서(4차 교훈과 동일한 패턴).
#[tauri::command]
pub async fn search_workspace(
    root: String,
    query: String,
) -> Result<Vec<md_core::search::SearchHit>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        md_core::search::search_tree(Path::new(&root), &query, 2000).map_err(err)
    })
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
    let mut builder = WebviewWindowBuilder::new(&app, &label, url)
        .title(&title)
        .inner_size(900.0, 700.0)
        .min_inner_size(480.0, 360.0);
    // 직전 보조 창 위치·크기가 세션에 있으면 재사용(창 관례 — 같은 자리에).
    if let Some(session) = app.try_state::<crate::state::AppState>().and_then(|st| st.session.clone()) {
        if let Some(rect) = session.aux_window {
            builder = builder.position(rect.x, rect.y).inner_size(rect.width, rect.height);
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

/// 작업 폴더 전체 찾아바꾸기 — 각 파일 원자적 저장(§4-2). 결과는 파일별 교체 수.
#[tauri::command]
pub async fn replace_workspace(
    root: String,
    needle: String,
    replacement: String,
    case_sensitive: bool,
) -> Result<Vec<md_core::search::ReplaceOutcome>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        md_core::search::replace_all_tree(
            std::path::Path::new(&root),
            &needle,
            &replacement,
            case_sensitive,
        )
        .map_err(err)
    })
    .await
    .map_err(err)?
}

/// 워크스페이스 위키링크 간선(출발 경로 → 대상 키).
#[tauri::command]
pub async fn wiki_edges(root: String) -> Result<Vec<md_core::search::WikiEdge>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        md_core::search::extract_wiki_edges(std::path::Path::new(&root)).map_err(err)
    })
    .await
    .map_err(err)?
}

/// 워크스페이스의 고아 이미지(참조 없는 assets/ 파일) 목록.
#[tauri::command]
pub async fn find_orphan_images(
    root: String,
) -> Result<Vec<md_core::search::OrphanAsset>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        md_core::search::find_orphan_assets(std::path::Path::new(&root)).map_err(err)
    })
    .await
    .map_err(err)?
}

/// 고아 이미지 일괄 삭제 — 사용자 확인 후 프런트가 부른다.
#[tauri::command]
pub async fn delete_orphan_images(paths: Vec<String>) -> Result<u32, String> {
    // 파일 삭제도 워커 스레드에서(메인 스레드 보호 — find_orphan_images와 동일 규칙).
    tauri::async_runtime::spawn_blocking(move || {
        let mut deleted = 0u32;
        for p in &paths {
            let path = std::path::Path::new(p);
            // 안전장치: 워크스페이스 assets/ 하위인지 확인(프런트가 이미 검증하지만 이중 방어).
            if !path.to_string_lossy().contains("/assets/") {
                continue;
            }
            if std::fs::remove_file(path).is_ok() {
                deleted += 1;
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 클립보드 이미지 → 파일로 저장(스크린샷 붙여넣기). 문서 폴더 assets/ 하위에
/// PNG로 기록하고 절대 경로를 돌려준다. 원문에는 표준 이미지 참조만 삽입된다
/// (프런트) — 저장 경로 외에는 아무 것도 기록하지 않는다.
#[tauri::command]
pub fn save_clipboard_image(dir: String) -> Result<String, String> {
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;
    let pasteboard: *mut objc2::runtime::AnyObject = unsafe {
        let cls: &objc2::runtime::AnyClass = class!(NSPasteboard);
        msg_send![cls, generalPasteboard]
    };
    if pasteboard.is_null() {
        return Err("클립보드에 접근할 수 없습니다".into());
    }
    // PNG 데이터 타입 확인·추출.
    let png_type = NSString::from_str("public.png");
    let data: *mut objc2_foundation::NSData = unsafe {
        msg_send![pasteboard, dataForType: &*png_type]
    };
    if data.is_null() {
        return Err("클립보드에 이미지가 없습니다".into());
    }
    let len = unsafe { (*data).len() };
    if len == 0 {
        return Err("클립보드 이미지가 비었습니다".into());
    }
    let raw: *const std::ffi::c_void = unsafe { msg_send![data, bytes] };
    let bytes = unsafe { std::slice::from_raw_parts(raw as *const u8, len) };
    // assets/ 디렉터리 + 타임스탬프 파일명.
    let dir_path = std::path::Path::new(&dir).join("assets");
    std::fs::create_dir_all(&dir_path).map_err(err)?;
    let name = format!(
        "paste-{}.png",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let out = dir_path.join(&name);
    md_core::io::write_bytes_atomic(&out, bytes).map_err(err)?;
    Ok(out.to_string_lossy().into_owned())
}

/// 드래그 앤 드롭 이미지 — 문서 폴더 assets/ 로 복사해 삽입 참조를 돌려준다
/// (붙여넣기 이미지와 같은 규약). 원본은 건드리지 않고 복사만.
#[tauri::command]
pub async fn import_image(src: String, dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ext = std::path::Path::new(&src)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        const OK: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"];
        if !OK.contains(&ext.as_str()) {
            return Err(format!("지원하지 않는 이미지 형식: .{ext}"));
        }
        let bytes = std::fs::read(&src).map_err(err)?;
        if bytes.is_empty() {
            return Err("이미지 파일이 비었습니다".into());
        }
        let dir_path = std::path::Path::new(&dir).join("assets");
        std::fs::create_dir_all(&dir_path).map_err(err)?;
        let stem = std::path::Path::new(&src)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|s| s.chars().filter(|c| c.is_alphanumeric() || *c == '-').take(40).collect::<String>())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "image".into());
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let out = dir_path.join(format!("{stem}-{ts}.{ext}"));
        md_core::io::write_bytes_atomic(&out, &bytes).map_err(err)?;
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
