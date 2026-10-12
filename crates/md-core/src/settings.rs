//! 설정 스키마 — `~/Library/Application Support/ai.iyagi.markdown/settings.json`.
//! 항목 수를 10개 내외로 유지하고(§4-7), 직접 JSON 편집이 가능해야 한다:
//! 알 수 없는 키는 무시하고, 빠진 키는 기본값으로 채운다.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeSetting {
    Light,
    Dark,
    #[default]
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LangSetting {
    #[default]
    Auto,
    En,
    Ko,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// 테마: 시스템 추종이 기본.
    #[serde(default)]
    pub theme: ThemeSetting,
    /// 편집기 기본 글꼴 크기(pt). 9~28.
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    /// 본문 최대 폭(px) — 읽기 모드 가독 한계선. 0이면 제한 없음.
    #[serde(default = "default_line_width")]
    pub line_width: f64,
    /// 앱 시작 기본 모드.
    #[serde(default)]
    pub default_mode: crate::session::ViewMode,
    /// 원격 이미지(http(s)) 자동 로드 — 기본 켬(§4-6 확정).
    #[serde(default = "default_true")]
    pub remote_images: bool,
    /// 인터페이스 언어.
    #[serde(default)]
    pub language: LangSetting,
    /// 문서에 래스터 이미지가 있을 때 편집 모드에서도 미리보기로 보여줄지.
    /// (성능 설정 — 큰 이미지가 많은 문서에서 끄면 빨라진다.)
    #[serde(default = "default_true")]
    pub show_images: bool,
    /// 로그 수준.
    #[serde(default = "default_log_level")]
    pub log_level: String,
    /// 초안 자동 저장 — 입력이 멈춘 뒤 원자적으로 저장한다(Word 자동 저장).
    #[serde(default)]
    pub autosave: bool,
    /// 타이프라이터 스크롤(입력 시 커서 줄 세로 중앙).
    #[serde(default)]
    pub typewriter: bool,
    /// 포커스 모드(커서 블록 외 흐림).
    #[serde(default)]
    pub focus_mode: bool,
    /// 문장 단위 포커스(iA Writer) — 포커스 모드가 켜일 때만 의미.
    #[serde(default)]
    pub focus_sentence: bool,
}

fn default_font_size() -> f64 {
    15.0
}
fn default_line_width() -> f64 {
    0.0 // 0 = 폭 제한 없음(창 가득) — Word 문서 관례.
}
fn default_true() -> bool {
    true
}
fn default_log_level() -> String {
    "info".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        serde_json::from_str("{}").unwrap()
    }
}

impl Settings {
    /// 파일에서 로드. 없거나 일부만 있으면 기본값 병합. 손상된 경우에도 앱은
    /// 떠야 한다 — 기본값으로 대체하고 오류 문자열을 반환해 로그로 남긴다.
    pub fn load(path: &Path) -> (Settings, Option<String>) {
        match std::fs::read_to_string(path) {
            Ok(text) if !text.trim().is_empty() => match serde_json::from_str(&text) {
                Ok(s) => (s, None),
                Err(e) => (
                    Settings::default(),
                    Some(format!(
                        "settings.json을 해석하지 못해 기본값을 씁니다: {e}"
                    )),
                ),
            },
            Ok(_) => (Settings::default(), None),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Settings::default(), None),
            Err(e) => (
                Settings::default(),
                Some(format!("settings.json을 읽지 못해 기본값을 씁니다: {e}")),
            ),
        }
    }

    /// 원자적 저장(md-core::io 참조).
    pub fn save(&self, path: &Path) -> Result<(), std::io::Error> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self).unwrap_or_default())?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

/// 설정 파일 경로: 앱 데이터 디렉터리 아래 `settings.json`.
pub fn settings_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("settings.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::ViewMode;

    fn tp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "md-core-settings-{tag}-{}.json",
            std::process::id()
        ))
    }

    #[test]
    fn defaults_are_sane() {
        let s = Settings::default();
        assert_eq!(s.theme, ThemeSetting::Auto);
        assert_eq!(s.font_size, 15.0);
        assert_eq!(s.line_width, 0.0);
        assert_eq!(s.default_mode, ViewMode::Edit);
        assert!(s.remote_images);
        assert_eq!(s.language, LangSetting::Auto);
    }

    #[test]
    fn partial_json_merges_defaults() {
        let p = tp("partial");
        std::fs::write(&p, r#"{"fontSize":17.5,"theme":"dark"}"#).unwrap();
        let (s, err) = Settings::load(&p);
        assert!(err.is_none());
        assert_eq!(s.font_size, 17.5);
        assert_eq!(s.theme, ThemeSetting::Dark);
        assert_eq!(s.default_mode, ViewMode::Edit);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn corrupt_json_still_returns_defaults_with_warning() {
        let p = tp("corrupt");
        std::fs::write(&p, "{{{").unwrap();
        let (s, err) = Settings::load(&p);
        assert_eq!(s, Settings::default());
        assert!(err.is_some());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn roundtrip() {
        let p = tp("rt");
        let s = Settings {
            font_size: 20.0,
            remote_images: false,
            ..Settings::default()
        };
        s.save(&p).unwrap();
        let (s2, err) = Settings::load(&p);
        assert!(err.is_none());
        assert_eq!(s, s2);
        let _ = std::fs::remove_file(&p);
    }
}
