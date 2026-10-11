//! 앱 전역 상태와 데이터 파일 경로.

use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

use tauri::{AppHandle, Emitter, Manager};

use md_core::recent::RecentList;
use md_core::session::SessionState;
use md_core::settings::Settings;

/// 데이터 파일들의 위치(`~/Library/Application Support/ai.iyagi.markdown/`).
pub struct AppPaths {
    pub settings: PathBuf,
    pub session: PathBuf,
    pub recent: PathBuf,
}

pub struct AppState {
    pub paths: AppPaths,
    pub settings: RwLock<Settings>,
    /// settings.json이 손상돼 기본값으로 돌아갔을 때의 안내(로그용).
    pub settings_warning: Option<String>,
    pub session: Option<SessionState>,
    pub recent: Mutex<RecentList>,
    /// 창이 뜨기 전에 도착한 열기 요청(더블클릭 두 번째 인스턴스 등).
    pub pending_files: Mutex<Vec<String>>,
    /// 문서별 스타일 저장소(SQLite 사이드카 — 원문 불변).
    pub style_db: Option<crate::style_db::StyleDb>,
}

/// setup에서 한 번만 호출. 상태를 만들어 manage한다.
pub fn init(app: &AppHandle) {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&data_dir);
    let paths = AppPaths {
        settings: md_core::settings::settings_path(&data_dir),
        session: md_core::session::session_path(&data_dir),
        recent: data_dir.join("recent.json"),
    };
    let (settings, settings_warning) = Settings::load(&paths.settings);
    let session = match md_core::session::load(&paths.session) {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!("세션 복원 실패, 새로 시작한다: {e}");
            None
        }
    };
    let recent = RecentList::load(&paths.recent);
    app.manage(AppState {
        paths,
        settings: RwLock::new(settings),
        settings_warning,
        session,
        recent: Mutex::new(recent),
        pending_files: Mutex::new(Vec::new()),
        style_db: crate::style_db::StyleDb::open(app),
    });
}

/// 열기 요청을 쌓는다. 프런트가 살아 있으면 바로 이벤트로도 보낸다.
pub fn queue_pending_files(app: &AppHandle, files: Vec<String>) {
    if files.is_empty() {
        return;
    }
    let state = app.state::<AppState>();
    state
        .pending_files
        .lock()
        .unwrap()
        .extend(files.iter().cloned());
    // 창이 이미 보이면 프런트가 곧바로 받는다. 아직 준비 전이면
    // take_pending_files로 나중에 가져간다.
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = app.emit("open-files", files);
            state.pending_files.lock().unwrap().clear();
        }
    }
}

/// 최근 목록 갱신 + 디스크 반영 + 메뉴의 Open Recent 재구성.
pub fn push_recent(app: &AppHandle, path: &str) {
    let state = app.state::<AppState>();
    let changed = state.recent.lock().unwrap().push(path);
    if changed {
        if let Err(e) = state.recent.lock().unwrap().save(&state.paths.recent) {
            tracing::warn!("최근 문서 저장 실패: {e}");
        }
        let _ = crate::menu::install(app);
    }
}
