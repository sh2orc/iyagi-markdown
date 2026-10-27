//! Recent workspace roots, shared across windows and independent of open tabs.
use md_core::recent::RecentEntry;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Serialize)]
pub struct WorkspaceHistory {
    revision: i64,
    entries: Vec<RecentEntry>,
}
#[derive(Deserialize)]
#[serde(tag = "kind", content = "path", rename_all = "camelCase")]
pub enum HistoryAction {
    Record(String),
    Remove(String),
    Clear,
}

pub(crate) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS workspace_history(path TEXT PRIMARY KEY, opened_order INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS workspace_history_state(id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO workspace_history_state VALUES(1, 0);")?;
    tx.commit()
}
fn snapshot(conn: &Connection) -> rusqlite::Result<WorkspaceHistory> {
    let revision = conn.query_row(
        "SELECT revision FROM workspace_history_state WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    let mut query =
        conn.prepare("SELECT path FROM workspace_history ORDER BY opened_order DESC, path")?;
    let paths = query
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let entries = paths
        .into_iter()
        .map(|path| {
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            RecentEntry { path, name }
        })
        .collect();
    Ok(WorkspaceHistory { revision, entries })
}
fn update(conn: &mut Connection, action: HistoryAction) -> rusqlite::Result<WorkspaceHistory> {
    let tx = conn.transaction()?;
    let current = snapshot(&tx)?;
    let changed = match action {
        HistoryAction::Record(path) => {
            if current
                .entries
                .first()
                .is_some_and(|entry| entry.path == path)
            {
                false
            } else {
                tx.execute(
                    "INSERT INTO workspace_history(path, opened_order) VALUES(?1, ?2)
                    ON CONFLICT(path) DO UPDATE SET opened_order = excluded.opened_order",
                    rusqlite::params![path, current.revision + 1],
                )?;
                tx.execute("DELETE FROM workspace_history WHERE path NOT IN (SELECT path FROM workspace_history ORDER BY opened_order DESC, path LIMIT 20)", [])?;
                true
            }
        }
        HistoryAction::Remove(path) => {
            tx.execute("DELETE FROM workspace_history WHERE path = ?1", [path])? > 0
        }
        HistoryAction::Clear => tx.execute("DELETE FROM workspace_history", [])? > 0,
    };
    if changed {
        tx.execute(
            "UPDATE workspace_history_state SET revision = revision + 1 WHERE id = 1",
            [],
        )?;
    }
    let next = snapshot(&tx)?;
    tx.commit()?;
    Ok(next)
}
fn db(app: &AppHandle) -> Result<std::sync::Arc<crate::style_db::StyleDb>, String> {
    app.state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or_else(|| "Workspace history storage unavailable".into())
}
#[tauri::command]
pub async fn get_workspace_history(app: AppHandle) -> Result<WorkspaceHistory, String> {
    let db = db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        snapshot(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn update_workspace_history(
    app: AppHandle,
    action: HistoryAction,
) -> Result<WorkspaceHistory, String> {
    let db = db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if let HistoryAction::Record(path) = &action {
            let value = std::path::Path::new(path);
            if path.len() > 16_384
                || !value.is_absolute()
                || path.chars().any(char::is_control)
                || value
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
                || !value.is_dir()
            {
                return Err("Choose an available workspace folder".into());
            }
        }
        let next = {
            let mut conn = db.conn.lock().map_err(|e| e.to_string())?;
            update(&mut conn, action).map_err(|e| e.to_string())?
        };
        if let Err(error) = app.emit("workspace-history-changed", &next) {
            tracing::warn!("Workspace history notification failed: {error}");
        }
        Ok(next)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        conn
    }
    #[test]
    fn caps_deduplicates_and_keeps_unavailable_roots() {
        let mut conn = db();
        for i in 0..22 {
            update(&mut conn, HistoryAction::Record(format!("/offline/{i}"))).unwrap();
        }
        let current = snapshot(&conn).unwrap();
        assert_eq!(current.entries.len(), 20);
        assert_eq!(current.entries[0].path, "/offline/21");
        let moved = update(&mut conn, HistoryAction::Record("/offline/2".into())).unwrap();
        assert_eq!(moved.entries[0].path, "/offline/2");
        assert_eq!(moved.entries.len(), 20);
        assert_eq!(
            update(&mut conn, HistoryAction::Record("/offline/2".into()))
                .unwrap()
                .revision,
            moved.revision
        );
        assert_eq!(
            update(&mut conn, HistoryAction::Remove("/missing".into()))
                .unwrap()
                .revision,
            moved.revision
        );
    }
    #[test]
    fn failed_save_rolls_back_membership_order_and_revision() {
        let mut conn = db();
        let original = update(&mut conn, HistoryAction::Record("/keep".into())).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_revision BEFORE UPDATE ON workspace_history_state BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
        assert!(update(&mut conn, HistoryAction::Record("/new".into())).is_err());
        assert!(update(&mut conn, HistoryAction::Clear).is_err());
        let after = snapshot(&conn).unwrap();
        assert_eq!(after.revision, original.revision);
        assert_eq!(after.entries, original.entries);
    }
    #[test]
    fn reopening_preserves_history_and_removing_does_not_touch_the_folder() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "iyagi-workspace-history-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("history.db");
        let workspace = dir.to_string_lossy().into_owned();
        {
            let mut conn = Connection::open(&path).unwrap();
            create_schema(&conn).unwrap();
            update(&mut conn, HistoryAction::Record(workspace.clone())).unwrap();
        }
        {
            let mut conn = Connection::open(&path).unwrap();
            create_schema(&conn).unwrap();
            assert_eq!(snapshot(&conn).unwrap().entries[0].path, workspace);
            assert_eq!(snapshot(&conn).unwrap().revision, 1);
            assert!(update(&mut conn, HistoryAction::Remove(workspace))
                .unwrap()
                .entries
                .is_empty());
            assert!(dir.is_dir());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
