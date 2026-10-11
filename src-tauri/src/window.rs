//! 메인 창 생성·표시. 세션에 저장된 위치·크기가 있으면 그대로 쓴다.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use md_core::session::WindowRect;

pub fn create_main(app: &AppHandle, rect: Option<WindowRect>) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    let mut builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::App("index.html".into()),
    )
    .title("IYAGI Markdown")
    .inner_size(1200.0, 820.0)
    .min_inner_size(680.0, 480.0)
    .visible(false); // 프런트가 준비되면 app_ready에서 보여준다(흰 플래시 방지)
    if let Some(r) = rect {
        if r.width >= 400.0 && r.height >= 320.0 {
            builder = builder.inner_size(r.width, r.height).position(r.x, r.y);
        }
    }
    builder.build()?;
    Ok(())
}

/// 메인 창을 앞으로 끌어온다(두 번째 인스턴스·RunEvent::Opened에서 호출).
pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}
