//! IYAGI Markdown의 macOS 전용 보조 기능.
//!
//! 파일 연결·열기 이벤트 자체는 Tauri(`RunEvent::Opened`)가 처리하므로
//! 여기는 순수 Cocoa 호출이 필요한 좁은 부분만 둔다:
//! - [`locale`]: NSUserDefaults의 AppleLanguages로 선호 언어 감지(메뉴 언어).

#[cfg(target_os = "macos")]
pub mod locale;

#[cfg(not(target_os = "macos"))]
pub mod locale {
    //! 비-macOS 폴백(리눅스 CI 등) — 환경 변수만 본다.
    pub fn preferred_languages() -> Vec<String> {
        std::env::var("LANG").ok().into_iter().collect()
    }
}
