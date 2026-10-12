//! 네이티브 메뉴. 문구는 md_core::i18n(설정 언어), 최근 문서 하위 메뉴는
//! state의 최근 목록에서 다시 구성한다.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager};

use md_core::i18n::Msg;

/// 우리가 프런트로 전달하는 커스텀 항목 id(미리 정의된 undo/cut 등과 구분).
const CUSTOM_IDS: &[&str] = &[
    "print",
    "new-tab",
    "open",
    "open-folder",
    "clear-recent",
    "save",
    "save-as",
    "export-html",
    "export-pdf",
    "export-docx",
    "close-tab",
    "find",
    "find-next",
    "find-prev",
    "replace",
    "mode-edit",
    "mode-read",
    "mode-source",
    "toggle-sidebar",
    "toggle-toc",
    "zoom-in",
    "zoom-out",
    "zoom-reset",
    "next-tab",
    "prev-tab",
    "shortcuts",
    "command-palette",
];

pub fn is_custom(id: &str) -> bool {
    CUSTOM_IDS.contains(&id) || id.starts_with("recent:")
}

/// 앱 메뉴 전체를 (재)구성해 설치한다. 언어 변경·최근 문서 변경 시에도 다시 불린다.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let lang = crate::commands::lang_of(
        &app.state::<crate::state::AppState>()
            .settings
            .read()
            .unwrap(),
    );
    let t = |m: Msg| m.text(lang);

    // — 앱 메뉴(macOS 첫 메뉴, 앱 이름) —
    let app_menu = Submenu::with_items(
        app,
        t(Msg::AppMenu),
        true,
        &[
            &PredefinedMenuItem::about(app, Some(t(Msg::About)), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(t(Msg::Hide)))?,
            &PredefinedMenuItem::hide_others(app, Some(t(Msg::HideOthers)))?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some(t(Msg::Quit)))?,
        ],
    )?;

    // — 파일 —
    let file_menu = Submenu::new(app, t(Msg::File), true)?;
    for (id, label, accel) in [
        ("new-tab", t(Msg::NewTab), Some("CmdOrCtrl+T")),
        ("open", t(Msg::Open), Some("CmdOrCtrl+O")),
        ("open-folder", t(Msg::OpenFolder), Some("Shift+CmdOrCtrl+O")),
    ] {
        file_menu.append(&mi(app, id, label, accel)?)?;
    }
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;

    // 최근 문서 하위 메뉴 — 없으면 비활성 항목 하나.
    {
        let st = app.state::<crate::state::AppState>();
        let recents = st.recent.lock().unwrap();
        let recent_menu = Submenu::new(app, t(Msg::OpenRecent), true)?;
        if recents.entries().is_empty() {
            recent_menu.append(&MenuItem::with_id(
                app,
                "no-recent",
                t(Msg::OpenRecent),
                false,
                None::<&str>,
            )?)?;
        } else {
            for e in recents.entries().iter().take(10) {
                recent_menu.append(&MenuItem::with_id(
                    app,
                    format!("recent:{}", e.path),
                    &e.name,
                    true,
                    None::<&str>,
                )?)?;
            }
            recent_menu.append(&PredefinedMenuItem::separator(app)?)?;
            recent_menu.append(&mi(app, "clear-recent", t(Msg::ClearRecent), None)?)?;
        }
        file_menu.append(&recent_menu)?;
    }

    file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (id, label, accel) in [
        ("save", t(Msg::Save), Some("CmdOrCtrl+S")),
        ("save-as", t(Msg::SaveAs), Some("Shift+CmdOrCtrl+S")),
    ] {
        file_menu.append(&mi(app, id, label, accel)?)?;
    }
    file_menu.append(&mi(app, "versions", t(Msg::Versions), None)?)?;
    file_menu.append(&mi(app, "print", t(Msg::Print), Some("CmdOrCtrl+P"))?)?;
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (id, label) in [
        ("export-html", t(Msg::ExportHtml)),
        ("export-pdf", t(Msg::ExportPdf)),
        ("export-docx", t(Msg::ExportDocx)),
    ] {
        file_menu.append(&mi(app, id, label, None)?)?;
    }
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;
    file_menu.append(&mi(
        app,
        "close-tab",
        t(Msg::CloseTab),
        Some("CmdOrCtrl+W"),
    )?)?;
    file_menu.append(&PredefinedMenuItem::close_window(
        app,
        Some(t(Msg::CloseWindow)),
    )?)?;

    // — 편집 —
    let edit_menu = Submenu::with_items(
        app,
        t(Msg::Edit),
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "find", t(Msg::Find), Some("CmdOrCtrl+F"))?,
            &mi(app, "find-next", t(Msg::FindNext), Some("CmdOrCtrl+G"))?,
            &mi(
                app,
                "find-prev",
                t(Msg::FindPrev),
                Some("Shift+CmdOrCtrl+G"),
            )?,
            &mi(app, "replace", t(Msg::Replace), Some("Alt+CmdOrCtrl+F"))?,
            &mi(
                app,
                "workspace-search",
                t(Msg::WorkspaceSearch),
                Some("Shift+CmdOrCtrl+F"),
            )?,
            &mi(app, "insert-symbols", t(Msg::InsertSymbols), None)?,
        ],
    )?;

    // — 보기 —
    let view_menu = Submenu::with_items(
        app,
        t(Msg::View),
        true,
        &[
            &mi(app, "command-palette", t(Msg::CommandPalette), Some("Shift-CmdOrCtrl-P"))?,
            &mi(app, "backlinks", t(Msg::Backlinks), None)?,
            &mi(app, "broken-links", t(Msg::BrokenLinks), None)?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "mode-edit", t(Msg::ModeEdit), None)?,
            &mi(app, "mode-read", t(Msg::ModeRead), Some("CmdOrCtrl+E"))?,
            &mi(app, "mode-source", t(Msg::ModeSource), Some("CmdOrCtrl+/"))?,
            &PredefinedMenuItem::separator(app)?,
            &mi(
                app,
                "toggle-sidebar",
                t(Msg::ToggleSidebar),
                Some("Shift+CmdOrCtrl+B"),
            )?,
            &mi(
                app,
                "toggle-toc",
                t(Msg::ToggleToc),
                Some("Shift+CmdOrCtrl+T"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "zoom-in", t(Msg::ZoomIn), Some("CmdOrCtrl+="))?,
            &mi(app, "zoom-out", t(Msg::ZoomOut), Some("CmdOrCtrl+-"))?,
            &mi(app, "zoom-reset", t(Msg::ActualSize), Some("CmdOrCtrl+0"))?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "next-tab", t(Msg::NextTab), Some("Shift+CmdOrCtrl+]"))?,
            &mi(app, "prev-tab", t(Msg::PrevTab), Some("Shift+CmdOrCtrl+["))?,
        ],
    )?;

    // — 도움말 —
    let help_menu = Submenu::with_items(
        app,
        t(Msg::Help),
        true,
        &[&mi(app, "shortcuts", t(Msg::Shortcuts), None)?],
    )?;

    // — 윈도우 —
    let window_menu = Submenu::with_items(
        app,
        t(Msg::Window),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(t(Msg::Minimize)))?,
            &PredefinedMenuItem::maximize(app, Some(t(Msg::Zoom)))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::bring_all_to_front(app, Some(t(Msg::BringAllToFront)))?,
        ],
    )?;

    let menu = Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )?;
    app.set_menu(menu).map(|_| ())
}

/// MenuItem 팩토리(제네릭 인자 추론을 한곳에 모은다).
fn mi<S: AsRef<str>>(
    app: &AppHandle,
    id: S,
    text: S,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, id.as_ref(), text.as_ref(), true, accelerator)
}
