//! 선호 언어 감지 — macOS 앱의 표준 규칙(NSUserDefaults AppleLanguages 배열).

use objc2_foundation::{NSString, NSUserDefaults};

/// NSUserDefaults `AppleLanguages`를 그대로 돌려준다(우선순위 순).
/// 없거나 실패하면 빈 벡터 — 호출자는 영어로 떨어진다.
pub fn preferred_languages() -> Vec<String> {
    let defaults = NSUserDefaults::standardUserDefaults();
    let key = NSString::from_str("AppleLanguages");
    let languages = match defaults.arrayForKey(&key) {
        Some(l) => l,
        None => return Vec::new(),
    };
    languages
        .iter()
        .filter_map(|obj| obj.downcast::<NSString>().ok())
        .map(|s| s.to_string())
        .collect()
}
