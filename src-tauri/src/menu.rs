//! 네이티브 메뉴. 문구는 md_core::i18n(설정 언어), 최근 문서 하위 메뉴는
//! state의 최근 목록에서 다시 구성한다.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager};

use md_core::i18n::Msg;

/// 앱 항목은 생성할 때 이름 공간을 붙인다. 별도 전달 목록을 유지하면 새
/// 메뉴가 화면에 보이면서도 이벤트를 잃을 수 있다. 시스템 편집 항목은 제외.
const COMMAND_PREFIX: &str = "iyagi:command:";

fn command_menu_id(command: &str) -> String {
    format!("{COMMAND_PREFIX}{command}")
}

pub fn command_id(menu_id: &str) -> Option<&str> {
    menu_id
        .strip_prefix(COMMAND_PREFIX)
        .filter(|id| !id.is_empty())
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
        // ⌘N — UI 전반(시작 화면·단축키 패널·명령 팔레트)이 ⌘N을 안내하며
        // 문서 앱 관례(⌘N=새 문서)에도 맞는다. ⇧⌘T(닫은 탭 복원)와의
        // 오타 혼동도 줄인다.
        ("new-tab", t(Msg::NewTab), Some("CmdOrCtrl+N")),
        ("open", t(Msg::Open), Some("CmdOrCtrl+O")),
        ("open-folder", t(Msg::OpenFolder), Some("Shift+CmdOrCtrl+O")),
    ] {
        file_menu.append(&mi(app, id, label, accel)?)?;
    }
    file_menu.append(&PredefinedMenuItem::separator(app)?)?;

    // 최근 문서 하위 메뉴 — 없으면 비활성 항목 하나.
    {
        let st = app.state::<crate::state::AppState>();
        let recents = st.recent.lock().unwrap().snapshot().entries;
        let recent_menu = Submenu::new(app, t(Msg::OpenRecent), true)?;
        if recents.is_empty() {
            recent_menu.append(&MenuItem::with_id(
                app,
                "no-recent",
                t(Msg::OpenRecent),
                false,
                None::<&str>,
            )?)?;
        } else {
            for e in recents.iter().take(10) {
                let label = if recents.iter().filter(|other| other.name == e.name).count() > 1 {
                    let parent = std::path::Path::new(&e.path)
                        .parent()
                        .unwrap_or(std::path::Path::new(""));
                    format!("{} — {}", e.name, parent.display())
                } else {
                    e.name.clone()
                };
                recent_menu.append(&MenuItem::with_id(
                    app,
                    command_menu_id(&format!("recent:{}", e.path)),
                    &label,
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
        ("export-epub", t(Msg::ExportEpub)),
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
    file_menu.append(&mi(
        app,
        "reopen-closed-tab",
        t(Msg::ReopenClosedTab),
        Some("Shift+CmdOrCtrl+T"),
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
            &mi(
                app,
                "command-palette",
                t(Msg::CommandPalette),
                Some("Shift-CmdOrCtrl-P"),
            )?,
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
                // ⇧⌘T는 닫은 탭 다시 열기와 겹친다 — 첫 등록(파일 메뉴)이
                // 이기므로 보기 메뉴의 이 항목은 작동하지 않는다. ⌥⌘T로.
                Some("Alt+CmdOrCtrl+T"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "zoom-in", t(Msg::ZoomIn), Some("CmdOrCtrl+="))?,
            &mi(app, "zoom-out", t(Msg::ZoomOut), Some("CmdOrCtrl+-"))?,
            &mi(app, "zoom-reset", t(Msg::ActualSize), Some("CmdOrCtrl+0"))?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "next-tab", t(Msg::NextTab), Some("Shift+CmdOrCtrl+]"))?,
            &mi(app, "prev-tab", t(Msg::PrevTab), Some("Shift+CmdOrCtrl+["))?,
            &PredefinedMenuItem::separator(app)?,
            &mi(
                app,
                "navigate-back",
                t(Msg::NavigateBack),
                Some("Alt+CmdOrCtrl+Left"),
            )?,
            &mi(
                app,
                "navigate-forward",
                t(Msg::NavigateForward),
                Some("Alt+CmdOrCtrl+Right"),
            )?,
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
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
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
    MenuItem::with_id(
        app,
        command_menu_id(id.as_ref()),
        text.as_ref(),
        true,
        accelerator,
    )
}

#[cfg(test)]
mod tests {
    use super::{command_id, command_menu_id};

    #[test]
    fn application_commands_do_not_need_a_second_registration_list() {
        for command in [
            "versions",
            "workspace-search",
            "insert-symbols",
            "backlinks",
            "broken-links",
            "future-command",
        ] {
            assert_eq!(command_id(&command_menu_id(command)), Some(command));
        }
        let recent = "recent:/notes/한글:chapter.md";
        assert_eq!(command_id(&command_menu_id(recent)), Some(recent));
    }

    #[test]
    fn system_and_placeholder_items_are_not_forwarded() {
        for id in ["undo", "copy", "paste", "no-recent", "", "iyagi:command:"] {
            assert_eq!(command_id(id), None);
        }
    }
}
