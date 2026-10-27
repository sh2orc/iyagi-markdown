//! User-selected documents; shared by every window and retained when files disappear.
use rusqlite::{Connection, Transaction};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

const MAX_FAVORITES: i64 = 500;

#[derive(Debug, Clone, Serialize)]
pub struct FavoritesSnapshot {
    pub revision: i64,
    pub paths: Vec<String>,
}

pub(crate) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS doc_favorite (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS favorites_state (
        id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO favorites_state(id, revision) VALUES(1, 0);",
    )?;
    let has_order = {
        let mut statement = tx.prepare("PRAGMA table_info(doc_favorite)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        columns.iter().any(|name| name == "sort_order")
    };
    if !has_order {
        // Preserve the previous registration order, once, inside the schema transaction.
        tx.execute_batch(
            "ALTER TABLE doc_favorite ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
            UPDATE doc_favorite SET sort_order = id;",
        )?;
    }
    tx.commit()
}

fn snapshot(conn: &Connection) -> rusqlite::Result<FavoritesSnapshot> {
    let revision = conn.query_row(
        "SELECT revision FROM favorites_state WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    let mut statement = conn.prepare("SELECT path FROM doc_favorite ORDER BY sort_order, id")?;
    let paths = statement
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(FavoritesSnapshot { revision, paths })
}

fn set(conn: &mut Connection, path: &str, present: bool) -> Result<FavoritesSnapshot, String> {
    if present
        && (path.len() > 16_384
            || !std::path::Path::new(path).is_absolute()
            || path.chars().any(char::is_control)
            || !md_core::tree::is_markdown_name(path)
            || std::path::Path::new(path)
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir)))
    {
        return Err("Choose a saved Markdown document".into());
    }
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let changed = if present {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM doc_favorite WHERE path = ?1)",
                [path],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if exists {
            0
        } else {
            let count: i64 = tx
                .query_row("SELECT COUNT(*) FROM doc_favorite", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            if count >= MAX_FAVORITES {
                return Err("You can keep up to 500 favorite documents".into());
            }
            tx.execute("INSERT INTO doc_favorite(path, sort_order) SELECT ?1, COALESCE(MAX(sort_order), 0) + 1 FROM doc_favorite", [path])
                .map_err(|error| error.to_string())?
        }
    } else {
        tx.execute("DELETE FROM doc_favorite WHERE path = ?1", [path])
            .map_err(|error| error.to_string())?
    };
    if changed > 0 {
        tx.execute(
            "UPDATE favorites_state SET revision = revision + 1 WHERE id = 1",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    let result = snapshot(&tx).map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MoveDirection {
    Up,
    Down,
}

#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum MoveError {
    Changed,
    Io(String),
}
impl From<rusqlite::Error> for MoveError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Io(error.to_string())
    }
}

fn move_entry(
    conn: &mut Connection,
    path: &str,
    direction: MoveDirection,
    expected_revision: i64,
) -> Result<FavoritesSnapshot, MoveError> {
    let tx = conn.transaction()?;
    let current = snapshot(&tx)?;
    if current.revision != expected_revision {
        return Err(MoveError::Changed);
    }
    let index = current
        .paths
        .iter()
        .position(|item| item == path)
        .ok_or(MoveError::Changed)?;
    let neighbor = match direction {
        MoveDirection::Up => index.checked_sub(1),
        MoveDirection::Down => (index + 1 < current.paths.len()).then_some(index + 1),
    };
    let Some(neighbor) = neighbor else {
        return Ok(current);
    };
    let other = &current.paths[neighbor];
    let order = |value: &str| {
        tx.query_row(
            "SELECT sort_order FROM doc_favorite WHERE path = ?1",
            [value],
            |row| row.get::<_, i64>(0),
        )
    };
    let first_order = order(path)?;
    let second_order = order(other)?;
    tx.execute("UPDATE doc_favorite SET sort_order = CASE WHEN path = ?1 THEN ?4 ELSE ?3 END WHERE path IN (?1, ?2)",
        rusqlite::params![path, other, first_order, second_order])?;
    tx.execute(
        "UPDATE favorites_state SET revision = revision + 1 WHERE id = 1",
        [],
    )?;
    let result = snapshot(&tx)?;
    tx.commit()?;
    Ok(result)
}

/// Rename along with document metadata. Merge an already-favorited destination
/// without duplicates; otherwise retain the original position.
pub(crate) fn rename(tx: &Transaction<'_>, from: &str, to: &str) -> rusqlite::Result<()> {
    if from == to {
        return Ok(());
    }
    let updated = tx.execute(
        "UPDATE OR IGNORE doc_favorite SET path = ?2 WHERE path = ?1",
        [from, to],
    )?;
    let removed = tx.execute("DELETE FROM doc_favorite WHERE path = ?1", [from])?;
    if updated + removed > 0 {
        tx.execute(
            "UPDATE favorites_state SET revision = revision + 1 WHERE id = 1",
            [],
        )?;
    }
    Ok(())
}

fn db(app: &AppHandle) -> Result<std::sync::Arc<crate::style_db::StyleDb>, String> {
    app.state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or_else(|| "Favorites storage is unavailable".into())
}

pub(crate) fn changed(app: &AppHandle) {
    let result = (|| -> Result<FavoritesSnapshot, String> {
        let db = db(app)?;
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        snapshot(&conn).map_err(|error| error.to_string())
    })();
    match result {
        Ok(value) => {
            if let Err(error) = app.emit("favorites-changed", value) {
                tracing::warn!("Favorites notification failed: {error}");
            }
        }
        Err(error) => tracing::warn!("Favorites could not be read after rename: {error}"),
    }
}

#[tauri::command]
pub async fn get_favorites(app: AppHandle) -> Result<FavoritesSnapshot, String> {
    let db = db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn.lock().map_err(|error| error.to_string())?;
        snapshot(&conn).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_favorite(
    app: AppHandle,
    path: String,
    present: bool,
) -> Result<FavoritesSnapshot, String> {
    let db = db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = {
            let mut conn = db.conn.lock().map_err(|error| error.to_string())?;
            set(&mut conn, &path, present)?
        };
        if let Err(error) = app.emit("favorites-changed", &result) {
            tracing::warn!("Favorites notification failed: {error}");
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn move_favorite(
    app: AppHandle,
    path: String,
    direction: MoveDirection,
    expected_revision: i64,
) -> Result<FavoritesSnapshot, MoveError> {
    let db = db(&app).map_err(MoveError::Io)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = {
            let mut conn = db
                .conn
                .lock()
                .map_err(|error| MoveError::Io(error.to_string()))?;
            move_entry(&mut conn, &path, direction, expected_revision)?
        };
        if let Err(error) = app.emit("favorites-changed", &result) {
            tracing::warn!("Favorites notification failed: {error}");
        }
        Ok(result)
    })
    .await
    .map_err(|error| MoveError::Io(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn explicit_membership_is_idempotent_and_keeps_missing_files_and_order() {
        let mut conn = database();
        assert_eq!(set(&mut conn, "/missing/a.md", true).unwrap().revision, 1);
        set(&mut conn, "/missing/b.md", true).unwrap();
        let same = set(&mut conn, "/missing/a.md", true).unwrap();
        assert_eq!(same.revision, 2);
        assert_eq!(same.paths, ["/missing/a.md", "/missing/b.md"]);
        let removed = set(&mut conn, "/missing/a.md", false).unwrap();
        assert_eq!(removed.revision, 3);
        assert_eq!(removed.paths, ["/missing/b.md"]);
        assert_eq!(set(&mut conn, "/missing/a.md", false).unwrap().revision, 3);
        assert!(set(&mut conn, "../bad.md", true).is_err());
        assert!(set(&mut conn, "/image.png", true).is_err());
    }

    #[test]
    fn renames_share_the_metadata_transaction_and_merge_duplicates() {
        let mut conn = database();
        set(&mut conn, "/a.md", true).unwrap();
        set(&mut conn, "/b.md", true).unwrap();
        {
            let tx = conn.transaction().unwrap();
            rename(&tx, "/a.md", "/renamed.md").unwrap();
        }
        assert_eq!(snapshot(&conn).unwrap().paths, ["/a.md", "/b.md"]);
        {
            let tx = conn.transaction().unwrap();
            rename(&tx, "/a.md", "/renamed.md").unwrap();
            tx.commit().unwrap();
        }
        assert_eq!(snapshot(&conn).unwrap().paths, ["/renamed.md", "/b.md"]);
        {
            let tx = conn.transaction().unwrap();
            rename(&tx, "/renamed.md", "/b.md").unwrap();
            tx.commit().unwrap();
        }
        let merged = snapshot(&conn).unwrap();
        assert_eq!(merged.paths, ["/b.md"]);
        assert_eq!(merged.revision, 4);
    }

    #[test]
    fn membership_and_revision_survive_reopening_the_database() {
        let path = std::env::temp_dir().join(format!("iyagi-favorites-{}.db", std::process::id()));
        {
            let mut conn = Connection::open(&path).unwrap();
            create_schema(&conn).unwrap();
            set(&mut conn, "/favorites/회의.md", true).unwrap();
        }
        {
            let conn = Connection::open(&path).unwrap();
            create_schema(&conn).unwrap();
            let restored = snapshot(&conn).unwrap();
            assert_eq!(restored.revision, 1);
            assert_eq!(restored.paths, ["/favorites/회의.md"]);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn old_schema_keeps_registration_order_and_does_not_reset_custom_order() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE doc_favorite(id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE);
            INSERT INTO doc_favorite(id, path) VALUES (3, '/a.md'), (8, '/b.md');
            CREATE TABLE favorites_state(id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
            INSERT INTO favorites_state VALUES(1, 2);").unwrap();
        create_schema(&conn).unwrap();
        assert_eq!(snapshot(&conn).unwrap().paths, ["/a.md", "/b.md"]);
        let moved = move_entry(&mut conn, "/b.md", MoveDirection::Up, 2).unwrap();
        assert_eq!(moved.paths, ["/b.md", "/a.md"]);
        create_schema(&conn).unwrap();
        let appended = set(&mut conn, "/c.md", true).unwrap();
        assert_eq!(appended.paths, ["/b.md", "/a.md", "/c.md"]);
        assert_eq!(appended.revision, 4);
        let tx = conn.transaction().unwrap();
        rename(&tx, "/b.md", "/renamed.md").unwrap();
        tx.commit().unwrap();
        assert_eq!(
            snapshot(&conn).unwrap().paths,
            ["/renamed.md", "/a.md", "/c.md"]
        );
    }

    #[test]
    fn reordering_uses_reviewed_revision_and_preserves_boundaries() {
        let mut conn = database();
        for path in ["/a.md", "/b.md", "/c.md"] {
            set(&mut conn, path, true).unwrap();
        }
        assert_eq!(
            move_entry(&mut conn, "/a.md", MoveDirection::Up, 3)
                .unwrap()
                .revision,
            3
        );
        assert_eq!(
            move_entry(&mut conn, "/c.md", MoveDirection::Down, 3)
                .unwrap()
                .revision,
            3
        );
        let first = move_entry(&mut conn, "/a.md", MoveDirection::Down, 3).unwrap();
        assert_eq!(first.paths, ["/b.md", "/a.md", "/c.md"]);
        assert!(matches!(
            move_entry(&mut conn, "/c.md", MoveDirection::Up, 3),
            Err(MoveError::Changed)
        ));
        assert_eq!(snapshot(&conn).unwrap().paths, first.paths);
        assert!(matches!(
            move_entry(&mut conn, "/missing.md", MoveDirection::Up, 4),
            Err(MoveError::Changed)
        ));
        assert_eq!(snapshot(&conn).unwrap().revision, 4);
    }

    #[test]
    fn reorder_write_failure_rolls_back_order_and_revision_together() {
        let mut conn = database();
        set(&mut conn, "/a.md", true).unwrap();
        set(&mut conn, "/b.md", true).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_move BEFORE UPDATE ON favorites_state BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
        assert!(matches!(
            move_entry(&mut conn, "/b.md", MoveDirection::Up, 2),
            Err(MoveError::Io(_))
        ));
        let current = snapshot(&conn).unwrap();
        assert_eq!(current.paths, ["/a.md", "/b.md"]);
        assert_eq!(current.revision, 2);
    }

    #[test]
    fn failed_write_rolls_back_membership_and_revision() {
        let mut conn = database();
        set(&mut conn, "/a.md", true).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_revision BEFORE UPDATE ON favorites_state BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
        assert!(set(&mut conn, "/a.md", false).is_err());
        let kept = snapshot(&conn).unwrap();
        assert_eq!(kept.paths, ["/a.md"]);
        assert_eq!(kept.revision, 1);
    }
}
