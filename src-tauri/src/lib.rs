//! Tauri 셸. 창·메뉴·명령(파일 IO·감시·내보내기)·생명주기를 소유한다.
//! 순수 로직은 `md-core`, macOS 호출은 `md-macos`, 내보내기는 `md-export`.

use tauri::{Emitter, Manager, RunEvent};

mod commands;
mod logging;
mod menu;
mod pdf;
mod state;
mod style_db;
mod watcher;
mod window;

pub fn run() {
    tauri::Builder::default()
        // 문서 앱은 인스턴스가 하나여야 한다: 두 번째 실행(더블클릭 포함)은
        // 첫 인스턴스에 파일 경로를 넘기고 바로 끝난다.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = extract_md_paths(&argv);
            if !files.is_empty() {
                state::queue_pending_files(app, files);
            }
            window::show_main(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            state::init(app.handle());
            let st = app.state::<state::AppState>();
            if let Some(warn) = &st.settings_warning {
                tracing::warn!("{warn}");
            }
            logging::init(app.handle());
            menu::install(app.handle()).expect("메뉴 구성 실패");
            let rect = st.session.as_ref().and_then(|s| s.window);
            window::create_main(app.handle(), rect)?;
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                lang = commands::lang_of(&st.settings.read().unwrap()).code(),
                "IYAGI Markdown started"
            );
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            // 미리 정의된 항목(undo/cut/…)은 시스템이 직접 처리한다 — 우리 이벤트만 전달.
            if !id.is_empty() && menu::is_custom(&id) {
                tracing::debug!(menu = %id, "menu event");
                let _ = app.emit("menu", id);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_ready,
            commands::app_info,
            commands::take_pending_files,
            commands::read_document,
            commands::write_document,
            commands::read_file_bytes,
            commands::scan_workspace,
            commands::search_workspace,
            commands::snapshot_list,
            commands::snapshot_read,
            commands::backlinks,
            commands::list_voices,
            commands::speak_start,
            commands::speak_stop,
            commands::speak_status,
            commands::import_image,
            commands::export_epub,
            commands::replace_workspace,
            commands::find_orphan_images,
            commands::wiki_edges,
            commands::delete_orphan_images,
            commands::get_settings,
            commands::set_settings,
            commands::get_session,
            commands::save_session,
            commands::get_recent,
            commands::clear_recent,
            commands::set_asset_scope,
            commands::watch_paths,
            commands::export_pdf,
            commands::export_docx,
            commands::write_export_file,
            commands::reveal_in_finder,
            commands::open_logs_dir,
            commands::save_clipboard_image,
            commands::open_in_new_window,
            style_db::doc_style_get,
            style_db::doc_style_set,
            style_db::doc_style_clear,
            style_db::bookmark_list,
            style_db::comment_list,
            style_db::comment_add,
            style_db::comment_update,
            style_db::comment_resolve,
            style_db::comment_remove,
            commands::file_rename,
            commands::file_duplicate,
            commands::new_file_in,
            style_db::bookmark_add,
            style_db::bookmark_remove,
        ])
        .build(tauri::generate_context!())
        .expect("error while building IYAGI Markdown")
        .run(|app, event| {
            if let RunEvent::Opened { urls } = event {
                // macOS: 실행 중 파일 더블클릭/Dock 드롭으로 열기.
                let files: Vec<String> = urls
                    .iter()
                    .filter_map(|u| {
                        u.to_file_path()
                            .ok()
                            .map(|p| p.to_string_lossy().into_owned())
                    })
                    .collect();
                tracing::info!(?files, "files opened via RunEvent::Opened");
                state::queue_pending_files(app, files);
                window::show_main(app);
            }
        });
}

/// 인자에서 `.md`/`.markdown` 경로만 뽑는다(실행 파일 경로·플래그는 제외).
fn extract_md_paths(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|a| {
            let p = std::path::Path::new(a);
            md_core::tree::is_markdown_name(a) && p.is_file()
        })
        .cloned()
        .collect()
}
