//! `~/Library/Logs/ai.iyagi.markdown/iyagi-markdown.log.<date>`(일 단위 회전) +
//! 개발 빌드에서는 stderr. 수준은 settings.json의 `log_level`.

use std::sync::OnceLock;

use tauri::{AppHandle, Manager};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

static GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

pub fn log_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_log_dir().ok()
}

pub fn init(app: &AppHandle) {
    let level = app
        .state::<crate::state::AppState>()
        .settings
        .read()
        .unwrap()
        .log_level
        .clone();
    let filter = EnvFilter::try_new(format!(
        "iyagi_markdown_app_lib={level},md_core={level},md_export={level},warn"
    ))
    .unwrap_or_else(|_| EnvFilter::new("info"));

    let file_layer = log_dir(app).and_then(|dir| {
        std::fs::create_dir_all(&dir).ok()?;
        let appender = tracing_appender::rolling::daily(dir, "iyagi-markdown.log");
        let (writer, guard) = tracing_appender::non_blocking(appender);
        let _ = GUARD.set(guard);
        Some(
            fmt::layer()
                .with_ansi(false)
                .with_target(false)
                .with_writer(writer),
        )
    });

    let registry = tracing_subscriber::registry().with(filter).with(file_layer);
    if cfg!(debug_assertions) {
        let _ = registry.with(fmt::layer().with_target(false)).try_init();
    } else {
        let _ = registry.try_init();
    }
}
