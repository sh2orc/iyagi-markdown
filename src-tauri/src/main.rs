#![cfg_attr(not(debug_assertions), tauri::windows_subsystem = "windows")]

fn main() {
    iyagi_markdown_app_lib::run()
}
