//! 파일을 휴지통으로 이동(NSFileManager recycle) — 영구 삭제 대신 복구 경로.
//! Finder에서 그대로 되돌릴 수 있어 오검출·실수가 치명적이지 않게 한다.

use objc2_foundation::{NSFileManager, NSString, NSURL};

/// 경로를 휴지통으로 이동. 성공 여부 — 실패 시 호출자가 기존 삭제로 폴백.
pub fn move_to_trash(path: &str) -> bool {
    let fm = NSFileManager::defaultManager();
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    fm.trashItemAtURL_resultingItemURL_error(&url, None).is_ok()
}

#[cfg(test)]
mod tests {
    use super::move_to_trash;

    #[test]
    fn 실제_파일을_휴지통으로_이동() {
        let dir = std::env::temp_dir();
        let p = dir.join(format!("iyagi-trash-test-{}.txt", std::process::id()));
        std::fs::write(&p, b"x").unwrap();
        assert!(move_to_trash(p.to_str().unwrap()));
        assert!(!p.exists()); // 원래 자리엔 없다(휴지통에 있다 — Finder에서 복구 가능)
    }

    #[test]
    fn 없는_경로는_실패() {
        assert!(!move_to_trash("/nonexistent/iyagi/nope.png"));
    }
}
