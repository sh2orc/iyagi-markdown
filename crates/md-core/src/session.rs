//! 세션 모델 — 탭·사이드바·창 상태의 저장과 복원(M06).
//!
//! 세션은 `~/Library/Application Support/ai.iyagi.markdown/session.json`에
//! 저장되고 앱 재시작 시 복원된다. **파일 내용은 저장하지 않는다**(진실 원본은
//! 디스크의 `.md`). dirty 상태의 탭은 복원 시 내용을 잃게 되므로 닫을 때
//! 확인을 받는 규칙(프런트)으로 보완한다.

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
    pub active: Option<String>,
    /// 사이드바 폴더(있으면 열림 상태로 복원).
    pub workspace: Option<String>,
    /// 참조 보기로 고정한 문서 경로(없으면 닫힘).
    #[serde(default)]
    pub pinned_path: Option<String>,
    /// 사이드바에서 접어 둔 폴더 경로들.
    #[serde(default)]
    pub collapsed_folders: Vec<String>,
    /// 목차 패널에서 접어 둔 제목 슬러그들.
    #[serde(default)]
    pub toc_collapsed: Vec<String>,
    /// 읽기 전용 잠금 문서 경로들.
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
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut v = state.clone();
    v.version = SESSION_VERSION;
    std::fs::write(path, serde_json::to_vec_pretty(&v)?)?;
    Ok(())
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
            tabs: vec![SessionTab {
                path: Some("/tmp/a.md".into()),
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
}
