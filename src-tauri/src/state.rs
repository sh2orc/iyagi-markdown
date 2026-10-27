//! 앱 전역 상태와 데이터 파일 경로.

use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::{Mutex, RwLock};

use tauri::{AppHandle, Emitter, Manager};

use md_core::recent::{RecentList, RecentSnapshot, RecentState};
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
    /// settings 잠금 안에서만 읽고 증가시켜 스냅샷과 순번을 함께 관찰한다.
    pub settings_revision: AtomicU64,
    /// settings.json이 손상돼 기본값으로 돌아갔을 때의 안내(로그용).
    pub settings_warning: Option<String>,
    /// session.json을 읽지 못해 새로 시작할 때의 안내(로그용 — 로거는 설정을
    /// 읽은 뒤에야 생기므로 init 시점엔 찍을 수 없다).
    pub session_warning: Option<String>,
    /// 마지막으로 저장된 세션(단일 원천). 시작 시 파일에서 읽고, save_session이
    /// 갱신한다 — 웹뷰 리로드 복원·보조 창 위치가 시작 시점 스냅샷이 아니라
    /// 최신 상태를 본다.
    pub session: Mutex<Option<SessionState>>,
    pub recent: Mutex<RecentState>,
    /// 창이 뜨기 전에 도착한 열기 요청(더블클릭 두 번째 인스턴스 등).
    pub pending_files: Mutex<Vec<String>>,
    /// 문서별 스타일 저장소(SQLite 사이드카 — 원문 불변).
    pub style_db: Option<std::sync::Arc<crate::style_db::StyleDb>>,
    /// 작성 초안 임시저장(SQLite — 미저장 내용의 재시작 복원 안전망).
    pub draft_db: Option<std::sync::Arc<crate::draft_db::DraftDb>>,
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
    let (session, session_warning) = match md_core::session::load(&paths.session) {
        Ok(s) => (Some(s), None),
        Err(e) => (None, Some(format!("세션 복원 실패, 새로 시작한다: {e}"))),
    };
    let recent = RecentList::load(&paths.recent);
    app.manage(AppState {
        paths,
        settings: RwLock::new(settings),
        settings_revision: AtomicU64::new(0),
        settings_warning,
        session_warning,
        session: Mutex::new(session),
        recent: Mutex::new(RecentState::new(recent)),
        pending_files: Mutex::new(Vec::new()),
        style_db: crate::style_db::StyleDb::open(app),
        draft_db: crate::draft_db::DraftDb::open(app),
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
pub fn update_recent(
    app: &AppHandle,
    change: impl FnOnce(&mut RecentList),
) -> Result<RecentSnapshot, String> {
    let state = app.state::<AppState>();
    let (snapshot, changed) = {
        let mut recent = state.recent.lock().unwrap();
        let before = recent.snapshot().revision;
        let snapshot = recent
            .update(&state.paths.recent, change)
            .map_err(|error| error.to_string())?;
        let changed = snapshot.revision != before;
        (snapshot, changed)
    };
    if !changed {
        return Ok(snapshot);
    }
    // 순번을 포함하므로 서로 다른 워커에서 이벤트 도착 순서가 바뀌어도 안전하다.
    if let Err(error) = app.emit("recent-changed", &snapshot) {
        tracing::warn!("최근 문서 변경 알림 실패: {error}");
    }
    let menu_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        // 메뉴 구성은 메인 스레드에서 최신 목록을 읽으며 순차적으로 수행한다.
        if let Err(error) = crate::menu::install(&menu_app) {
            tracing::warn!("최근 문서는 저장했지만 메뉴 갱신 실패: {error}");
        }
    }) {
        tracing::warn!("최근 문서 메뉴 갱신 예약 실패: {error}");
    }
    Ok(snapshot)
}
