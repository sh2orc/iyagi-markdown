//! 검토한 일괄 바꾸기만 실행한다. 원문은 프런트에 보내지 않고 제한된 캐시에 둔다.
use md_core::search::{ReplaceFailure, ReplaceReport, ReplacementPlan};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Default)]
pub struct ReplacementState(Mutex<Cache>);

#[derive(Default)]
struct Cache {
    sequence: u32,
    plan: Option<Pending>,
}

struct Pending {
    id: u32,
    owner: String,
    created: Instant,
    plan: ReplacementPlan,
    rename: Option<(md_core::wiki_rename::RenameGuard, i64)>,
}

#[derive(Serialize)]
pub struct PreviewFile {
    path: String,
    count: usize,
    before: String,
    after: String,
}

#[derive(Serialize)]
pub struct Preview {
    id: u32,
    files: Vec<PreviewFile>,
    skipped: Vec<ReplaceFailure>,
}

#[tauri::command]
pub async fn preview_replacement(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    root: String,
    needle: String,
    replacement: String,
    case_sensitive: bool,
) -> Result<Preview, String> {
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ReplacementState>();
        // 미리보기 생성도 직렬화하여 여러 창이 큰 계획을 동시에 만들지 않는다.
        let mut cache = state.0.lock().unwrap();
        cache.plan = None;
        let plan = md_core::search::prepare_replacement(
            std::path::Path::new(&root),
            &needle,
            &replacement,
            case_sensitive,
        )
        .map_err(|error| error.to_string())?;
        Ok(cache_preview(&mut cache, owner, plan, None))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn cache_preview(
    cache: &mut Cache,
    owner: String,
    plan: ReplacementPlan,
    rename: Option<(md_core::wiki_rename::RenameGuard, i64)>,
) -> Preview {
    cache.sequence = cache.sequence.wrapping_add(1);
    let id = cache.sequence;
    let files = plan
        .files
        .iter()
        .map(|file| {
            let first = file
                .before
                .lines()
                .zip(file.after.lines())
                .position(|(before, after)| before != after)
                .unwrap_or(0);
            let before = file.before.lines().nth(first).unwrap_or("");
            let after = file.after.lines().nth(first).unwrap_or("");
            let shared = before
                .chars()
                .zip(after.chars())
                .take_while(|(a, b)| a == b)
                .count();
            let start = shared.saturating_sub(80);
            let clip = |line: &str| {
                let mut snippet: String = line.chars().skip(start).take(240).collect();
                if start > 0 {
                    snippet.insert(0, '…');
                }
                if line.chars().count() > start + 240 {
                    snippet.push('…');
                }
                snippet
            };
            PreviewFile {
                path: file.path.clone(),
                count: file.count,
                before: clip(before),
                after: clip(after),
            }
        })
        .collect();
    let preview = Preview {
        id,
        files,
        skipped: plan.skipped.clone(),
    };
    cache.plan = Some(Pending {
        id,
        owner,
        created: Instant::now(),
        plan,
        rename,
    });
    preview
}

#[tauri::command]
pub async fn preview_wiki_rename(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: i64,
) -> Result<Preview, String> {
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = crate::rename_jobs::operation_guard();
        let db = app
            .state::<crate::state::AppState>()
            .style_db
            .clone()
            .ok_or("Rename recovery storage is unavailable")?;
        let job = db.rename_job(id)?;
        if !job.ready {
            return Err("The interrupted rename must be reviewed before updating links.".into());
        }
        let state = app.state::<ReplacementState>();
        let mut cache = state.0.lock().map_err(|e| e.to_string())?;
        cache.plan = None;
        let (plan, guard) = md_core::wiki_rename::prepare(
            std::path::Path::new(&job.root),
            std::path::Path::new(&job.from),
            std::path::Path::new(&job.to),
        )
        .map_err(|e| e.to_string())?;
        Ok(cache_preview(&mut cache, owner, plan, Some((guard, id))))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn apply_replacement(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    id: u32,
) -> Result<ReplaceReport, String> {
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ReplacementState>();
        let pending = {
            let mut cache = state.0.lock().unwrap();
            let valid = cache.plan.as_ref().is_some_and(|pending| {
                pending.id == id
                    && pending.owner == owner
                    && pending.created.elapsed() < Duration::from_secs(300)
            });
            if !valid {
                return Err("REPLACEMENT_PREVIEW_EXPIRED".into());
            }
            cache.plan.take().unwrap()
        };
        // Never wait for the rename gate while holding the preview cache mutex.
        let _operation = pending
            .rename
            .as_ref()
            .map(|_| crate::rename_jobs::operation_guard());
        if let Some((guard, id)) = pending.rename {
            let db = app
                .state::<crate::state::AppState>()
                .style_db
                .clone()
                .ok_or("Rename recovery storage is unavailable")?;
            if !db.rename_job(id)?.ready {
                return Err("The rename review is not ready".into());
            }
            guard.validate().map_err(|e| e.to_string())?;
        }
        let plan = pending.plan;
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        Ok(md_core::search::apply_replacement(plan, |file| {
            md_core::snapshots::save_before_bulk(&dir, &file.path, &file.before)
        }))
    })
    .await
    .map_err(|error| error.to_string())?
}
