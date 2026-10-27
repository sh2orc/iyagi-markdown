//! 세션 모델 — 탭·사이드바·창 상태의 저장과 복원(M06).
//!
//! 세션은 `~/Library/Application Support/ai.iyagi.markdown/session.json`에
//! 저장되고 앱 재시작 시 복원된다. **파일 내용은 저장하지 않는다**(진실 원본은
//! 디스크의 `.md`). 미저장 내용은 별도의 drafts.db에서 복구하고,
//! 세션 밖 초안도 삭제하지 않고 복원 후보로 제공한다.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const SESSION_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    #[default]
    Edit,
    Read,
    Source,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    /// 열린 파일의 절대 경로. 새 문서(아직 저장 안 됨)는 None.
    pub path: Option<String>,
    /// 창·탭별 초안 정체성. 파일 탭도 키를 유지하며, 구버전 세션만 None일 수 있다.
    #[serde(default)]
    pub draft_key: Option<String>,
    /// 마지막 보기 모드.
    pub mode: ViewMode,
    /// 커서 위치(문서 오프셋)와 최상단 표시 줄.
    #[serde(default)]
    pub cursor: usize,
    #[serde(default)]
    pub scroll: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub version: u32,
    pub tabs: Vec<SessionTab>,
    /// 활성 탭의 초안 키. 구버전 세션의 파일 경로도 허용한다.
    pub active: Option<String>,
    /// 사이드바 폴더(있으면 열림 상태로 복원).
    pub workspace: Option<String>,
    /// 참조 보기의 문서 경로 또는 초안 키(없으면 닫힘).
    #[serde(default)]
    pub pinned_path: Option<String>,
    /// 사이드바에서 접어 둔 폴더 경로들.
    #[serde(default)]
    pub collapsed_folders: Vec<String>,
    /// 목차 패널에서 접어 둔 제목 슬러그들.
    #[serde(default)]
    pub toc_collapsed: Vec<String>,
    /// 읽기 전용 잠금 문서 경로 또는 초안 키들.
    #[serde(default)]
    pub locked_paths: Vec<String>,
    #[serde(default = "default_true")]
    pub sidebar_open: bool,
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: f64,
    #[serde(default = "default_toc_open")]
    pub toc_open: bool,
    /// 창 위치·크기(화면 좌표). 없으면 기본 위치.
    #[serde(default)]
    pub window: Option<WindowRect>,
    /// 보조 창(새 창으로 열기)의 마지막 위치·크기.
    #[serde(default)]
    pub aux_window: Option<WindowRect>,
}

fn default_true() -> bool {
    true
}
fn default_sidebar_width() -> f64 {
    240.0
}
fn default_toc_open() -> bool {
    true // 문서를 열면 목차가 보이는 게 Word 문서 앱 관례.
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            version: SESSION_VERSION,
            tabs: Vec::new(),
            active: None,
            workspace: None,
            pinned_path: None,
            collapsed_folders: Vec::new(),
            toc_collapsed: Vec::new(),
            locked_paths: Vec::new(),
            sidebar_open: true,
            sidebar_width: default_sidebar_width(),
            toc_open: false,
            window: None,
            aux_window: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("세션 파일을 읽을 수 없습니다: {0}")]
    Io(#[from] std::io::Error),
    #[error("세션 파일이 올바른 JSON이 아닙니다: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("세션 파일을 쓸 수 없습니다: {0}")]
    Write(#[from] crate::io::DocError),
}

/// 세션을 로드한다. 없으면 기본값, 미래 버전이면 무시하고 기본값(안전 복원 실패).
pub fn load(path: &Path) -> Result<SessionState, SessionError> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(SessionState::default()),
        Err(e) => return Err(e.into()),
    };
    if bytes.is_empty() {
        return Ok(SessionState::default());
    }
    let state: SessionState = serde_json::from_slice(&bytes)?;
    if state.version > SESSION_VERSION {
        return Ok(SessionState::default());
    }
    Ok(state)
}

/// 세션을 원자적으로 저장한다(부분 기록으로 인한 복원 실패 방지).
pub fn save(path: &Path, state: &SessionState) -> Result<(), SessionError> {
    let mut v = state.clone();
    v.version = SESSION_VERSION;
    // 임시 파일 → fsync → rename. 쓰는 도중 프로세스가 죽어도(개발 중 재빌드
    // 재시작·강제 종료) 잘린 JSON이 남아 다음 실행이 빈 세션이 되는 일이 없다.
    crate::io::write_bytes_atomic(path, &serde_json::to_vec_pretty(&v)?)?;
    Ok(())
}

/// 창 하나의 저장 요청을 현재 세션에 합친다. 탭·사이드바·메인 창 위치는
/// 메인 창이 소유하고, 보조 창(새 창으로 열기)은 자기 위치(`aux_window`)만
/// 기여한다 — 보조 창의 스토어는 자기 탭 하나뿐이라 통째로 저장하면 메인의
/// 세션을 덮어쓴다. `None`이면 반영할 것이 없다.
pub fn merge_from_window(
    current: Option<&SessionState>,
    incoming: SessionState,
    from_main: bool,
) -> Option<SessionState> {
    if from_main {
        let mut next = incoming;
        // 메인 스토어는 보조 창 위치를 모른다(항상 None) — 기존 값 보존.
        if next.aux_window.is_none() {
            next.aux_window = current.and_then(|c| c.aux_window);
        }
        Some(next)
    } else {
        let rect = incoming.aux_window?;
        let mut next = current?.clone();
        next.aux_window = Some(rect);
        Some(next)
    }
}

/// 세션 저장 경로: 앱 데이터 디렉터리 아래 `session.json`.
pub fn session_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("session.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("md-core-session-{tag}-{}.json", std::process::id()))
    }

    #[test]
    fn roundtrip_and_defaults() {
        let path = sp("rt");
        let _ = std::fs::remove_file(&path);
        assert_eq!(load(&path).unwrap(), SessionState::default());
        let state = SessionState {
            version: SESSION_VERSION,
            pinned_path: None,
            collapsed_folders: Vec::new(),
            toc_collapsed: Vec::new(),
            locked_paths: Vec::new(),
            tabs: vec![SessionTab {
                path: Some("/tmp/a.md".into()),
                draft_key: None,
                mode: ViewMode::Read,
                cursor: 42,
                scroll: 3,
            }],
            active: Some("/tmp/a.md".into()),
            workspace: Some("/tmp".into()),
            sidebar_open: false,
            sidebar_width: 300.0,
            toc_open: true,
            window: Some(WindowRect {
                x: 1.0,
                y: 2.0,
                width: 900.0,
                height: 700.0,
            }),
            aux_window: None,
        };
        save(&path, &state).unwrap();
        assert_eq!(load(&path).unwrap(), state);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn future_version_falls_back_to_default() {
        let path = sp("future");
        std::fs::write(
            &path,
            r#"{"version":99,"tabs":[],"active":null,"workspace":null,"sidebarOpen":true,"sidebarWidth":240.0,"tocOpen":false,"window":null}"#,
        )
        .unwrap();
        assert_eq!(load(&path).unwrap(), SessionState::default());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn missing_optional_fields_default() {
        let path = sp("defaults");
        std::fs::write(
            &path,
            r#"{"version":1,"tabs":[{"path":"/x.md","mode":"edit"}],"active":"/x.md","workspace":null}"#,
        )
        .unwrap();
        let s = load(&path).unwrap();
        assert_eq!(s.tabs[0].cursor, 0);
        assert_eq!(s.tabs[0].scroll, 0);
        assert!(s.sidebar_open);
        assert_eq!(s.sidebar_width, 240.0);
        let _ = std::fs::remove_file(&path);
    }

    fn rect(x: f64) -> WindowRect {
        WindowRect {
            x,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        }
    }

    fn with_tab(path: &str) -> SessionState {
        SessionState {
            tabs: vec![SessionTab {
                path: Some(path.into()),
                draft_key: None,
                mode: ViewMode::Edit,
                cursor: 0,
                scroll: 0,
            }],
            active: Some(path.into()),
            ..SessionState::default()
        }
    }

    #[test]
    fn aux_window_save_only_updates_its_rect() {
        // 보조 창 스토어의 세션(자기 문서 하나)이 메인의 탭을 덮어쓰면 안 된다.
        let main = SessionState {
            window: Some(rect(10.0)),
            ..with_tab("/main.md")
        };
        let aux = SessionState {
            window: Some(rect(500.0)),
            aux_window: Some(rect(500.0)),
            ..with_tab("/aux.md")
        };
        let next = merge_from_window(Some(&main), aux, false).unwrap();
        assert_eq!(next.tabs, main.tabs);
        assert_eq!(next.active.as_deref(), Some("/main.md"));
        assert_eq!(next.window, Some(rect(10.0)));
        assert_eq!(next.aux_window, Some(rect(500.0)));
        // 위치 없는 보조 창 요청(디바운스 저장)·현재 세션 없음은 반영할 것이 없다.
        assert!(merge_from_window(Some(&main), with_tab("/aux.md"), false).is_none());
        assert!(merge_from_window(
            None,
            SessionState {
                aux_window: Some(rect(1.0)),
                ..with_tab("/a.md")
            },
            false
        )
        .is_none());
    }

    #[test]
    fn main_save_keeps_known_aux_rect() {
        let current = SessionState {
            aux_window: Some(rect(500.0)),
            ..with_tab("/old.md")
        };
        let next = merge_from_window(Some(&current), with_tab("/new.md"), true).unwrap();
        assert_eq!(next.active.as_deref(), Some("/new.md"));
        assert_eq!(next.aux_window, Some(rect(500.0)));
    }

    #[test]
    fn save_is_atomic_no_tmp_left() {
        let dir = sp("atomic").with_extension("test-dir");
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("session.json");
        save(&path, &with_tab("/x.md")).unwrap();
        assert_eq!(load(&path).unwrap().tabs.len(), 1);
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.starts_with(".iyagi-tmp-")
            })
            .count();
        assert_eq!(leftovers, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
