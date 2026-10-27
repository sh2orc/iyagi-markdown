//! Tauri 셸. 창·메뉴·명령(파일 IO·감시·내보내기)·생명주기를 소유한다.
//! 순수 로직은 `md-core`, macOS 호출은 `md-macos`, 내보내기는 `md-export`.

use tauri::{Emitter, Manager, RunEvent};

mod commands;
mod draft_db;
mod favorites;
mod logging;
mod menu;
mod pdf;
mod quit;
mod rename_jobs;
mod replacement;
mod state;
mod style_db;
mod template_archive;
mod user_templates;
mod watcher;
mod window;
mod workspace_history;

pub fn run() {
    tauri::Builder::default()
        .manage(quit::QuitState::default())
        .manage(replacement::ReplacementState::default())
        // 문서 앱은 인스턴스가 하나여야 한다: 두 번째 실행(더블클릭 포함)은
        // 첫 인스턴스에 파일 경로를 넘기고 바로 끝난다.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            quit::cancel(app);
            let files = extract_md_paths(&argv);
            // 두 번째 실행은 기존 인스턴스에서 처리하고 조용히 끝난다 — 사용자
            // 터미널엔 아무 것도 안 남아 실패로 오해되므로 앱 로그에 근거를 남긴다.
            tracing::info!(
                count = files.len(),
                "두 번째 실행 — 기존 인스턴스 활성화(single-instance)"
            );
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
            logging::init(app.handle());
            // 로거가 생긴 뒤에 찍는다(그 전의 tracing 호출은 어디에도 남지 않는다).
            for warn in [&st.settings_warning, &st.session_warning]
                .into_iter()
                .flatten()
            {
                tracing::warn!("{warn}");
            }
            menu::install(app.handle()).expect("메뉴 구성 실패");
            let rect = st.session.lock().unwrap().as_ref().and_then(|s| s.window);
            window::create_main(app.handle(), rect)?;
            tracing::info!(
                version = env!("CARGO_PKG_VERSION"),
                lang = commands::lang_of(&st.settings.read().unwrap()).code(),
                "IYAGI Markdown started"
            );
            Ok(())
        })
        .on_menu_event(|app, event| {
            // 미리 정의된 항목(undo/cut/…)은 시스템이 직접 처리한다 — 우리 이벤트만 전달.
            if let Some(id) = menu::command_id(event.id().as_ref()) {
                tracing::debug!(menu = %id, "menu event");
                if let Some(window) = app
                    .webview_windows()
                    .into_values()
                    .find(|window| window.is_focused().unwrap_or(false))
                {
                    let _ = app.emit_to(window.label(), "menu", id.to_owned());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            quit::quit_reply,
            quit::quit_pending,
            commands::log_error,
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
            commands::snapshot_backup,
            commands::backlinks,
            commands::list_voices,
            commands::speak_start,
            commands::speak_stop,
            commands::speak_status,
            commands::import_image,
            commands::export_epub,
            replacement::preview_replacement,
            replacement::apply_replacement,
            commands::find_orphan_images,
            commands::document_edges,
            commands::inspect_links,
            commands::create_link_document,
            commands::delete_orphan_images,
            commands::get_settings,
            commands::patch_settings,
            commands::get_session,
            commands::save_session,
            commands::get_recent,
            favorites::get_favorites,
            favorites::set_favorite,
            favorites::move_favorite,
            user_templates::list_user_templates,
            user_templates::get_user_template,
            user_templates::put_user_template,
            user_templates::delete_user_template,
            template_archive::read_template_archive,
            template_archive::export_template_archive,
            template_archive::import_template_archive,
            workspace_history::get_workspace_history,
            workspace_history::update_workspace_history,
            commands::record_recent,
            commands::remove_recent,
            commands::clear_recent,
            commands::set_asset_scope,
            commands::watch_paths,
            commands::export_pdf,
            commands::export_docx,
            commands::write_export_file,
            commands::reveal_in_finder,
            commands::open_logs_dir,
            commands::save_image_bytes,
            commands::open_in_new_window,
            style_db::doc_style_get,
            style_db::doc_style_set,
            style_db::doc_style_clear,
            draft_db::draft_save,
            draft_db::draft_load,
            draft_db::draft_clear,
            draft_db::draft_list,
            style_db::bookmark_list,
            style_db::comment_list,
            style_db::comment_add,
            style_db::comment_update,
            style_db::comment_resolve,
            style_db::comment_remove,
            style_db::comment_reanchor,
            style_db::baseline_get,
            style_db::baseline_write,
            commands::file_rename,
            commands::file_duplicate,
            commands::review_document_trash,
            commands::trash_document,
            commands::new_file_in,
            commands::new_folder_in,
            replacement::preview_wiki_rename,
            rename_jobs::pending_renames,
            rename_jobs::finish_rename_review,
            style_db::bookmark_set,
            style_db::bookmark_replace,
        ])
        .build(tauri::generate_context!())
        .expect("error while building IYAGI Markdown")
        .run(|app, event| {
            // ⌘Q도 모든 창의 미저장 확인·저장 완료를 거친다.
            if let RunEvent::ExitRequested { api, .. } = &event {
                if quit::confirmed(app) {
                    return;
                }
                api.prevent_exit();
                quit::request(app);
                return;
            }
            if let RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                quit::cancel(app);
            }
            if let RunEvent::Opened { urls } = event {
                quit::cancel(app);
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
