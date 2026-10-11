// Windows 콘솔 창 방지(Windows 빌드 시에만 의미 있음 — macOS 전용 앱이지만
// 표준 관례로 유지). Tauri 2에서는 std 속성을 직접 쓴다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    iyagi_markdown_app_lib::run()
}
