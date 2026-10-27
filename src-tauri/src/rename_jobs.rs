//! 파일 이름 변경 전에 링크 검토 작업을 기록한다. 중단 후에는 파일 정체성으로 재개한다.
use crate::style_db::StyleDb;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::os::unix::fs::MetadataExt;
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
};
use tauri::{AppHandle, Emitter, Manager};

// 링크 적용 중 다른 창이 작업을 지우거나 겹치는 폴더의 이름을 바꾸지 못하게 한다.
static OPERATIONS: Mutex<()> = Mutex::new(());
pub(crate) fn operation_guard() -> MutexGuard<'static, ()> {
    OPERATIONS.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS pending_rename (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root TEXT NOT NULL, scope TEXT NOT NULL,
        old_path TEXT NOT NULL, new_path TEXT NOT NULL,
        device TEXT NOT NULL, inode TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('prepared', 'ready')),
        created_at REAL NOT NULL DEFAULT (unixepoch()),
        UNIQUE(scope)
    );",
    )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRename {
    pub id: i64,
    pub root: String,
    pub from: String,
    pub to: String,
    pub ready: bool,
    pub error: Option<String>,
}

impl StyleDb {
    // Caller holds operation_guard and document_write_guard through the filesystem rename.
    pub(crate) fn prepare_rename_job(
        &self,
        root: &str,
        from: &str,
        to: &str,
    ) -> Result<i64, String> {
        let root_path = Path::new(root);
        let old = Path::new(from);
        let new = Path::new(to);
        if !root_path.is_absolute()
            || !old.starts_with(root_path)
            || !new.starts_with(root_path)
            || old.parent() != new.parent()
            || old == new
            || old
                .components()
                .chain(new.components())
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err("Invalid rename workspace or document paths".into());
        }
        let scope = root_path.canonicalize().map_err(|e| e.to_string())?;
        let parent = old
            .parent()
            .ok_or("Document folder missing")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !parent.starts_with(&scope) {
            return Err("Document is outside the workspace".into());
        }
        let identity = std::fs::symlink_metadata(old).map_err(|e| e.to_string())?;
        if !identity.is_file() {
            return Err("Rename requires a regular document file".into());
        }
        let scope = scope
            .to_str()
            .ok_or("Unsupported workspace path encoding")?;
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let scopes = {
            let mut query = tx
                .prepare("SELECT scope FROM pending_rename")
                .map_err(|e| e.to_string())?;
            let rows = query
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        if scopes
            .iter()
            .any(|other| Path::new(scope).starts_with(other) || Path::new(other).starts_with(scope))
        {
            return Err("Review or dismiss the pending rename in this workspace before renaming another file.".into());
        }
        tx.execute(
            "INSERT INTO pending_rename(root, scope, old_path, new_path, device, inode, phase)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'prepared')",
            rusqlite::params![
                root,
                scope,
                from,
                to,
                identity.dev().to_string(),
                identity.ino().to_string()
            ],
        )
        .map_err(|e| e.to_string())?;
        let id = tx.last_insert_rowid();
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub(crate) fn mark_rename_ready(&self, id: i64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let changed = conn
            .execute(
                "UPDATE pending_rename SET phase = 'ready' WHERE id = ?1",
                [id],
            )
            .map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err("The rename recovery record is missing".into());
        }
        Ok(())
    }

    pub(crate) fn remove_rename_job(&self, id: i64) -> Result<(), String> {
        self.conn
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM pending_rename WHERE id = ?1", [id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn find_rename_job(&self, id: i64) -> Result<Option<PendingRename>, String> {
        self.conn
            .lock()
            .map_err(|e| e.to_string())?
            .query_row(
                "SELECT id, root, old_path, new_path, phase FROM pending_rename WHERE id = ?1",
                [id],
                |row| {
                    Ok(PendingRename {
                        id: row.get(0)?,
                        root: row.get(1)?,
                        from: row.get(2)?,
                        to: row.get(3)?,
                        ready: row.get::<_, String>(4)? == "ready",
                        error: None,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub(crate) fn rename_job(&self, id: i64) -> Result<PendingRename, String> {
        self.find_rename_job(id)?
            .ok_or_else(|| "This rename review has already been completed or dismissed.".into())
    }

    // Caller also holds the document write guard: the final scan and acknowledgement
    // cannot race an app write. Explicit dismissal only removes this recovery record.
    pub(crate) fn finish_rename_review(&self, id: i64, discard: bool) -> Result<(), String> {
        let Some(job) = self.find_rename_job(id)? else {
            return Ok(());
        };
        if !discard {
            if !job.ready {
                return Err("Review the interrupted rename before marking it complete.".into());
            }
            let (plan, _) = md_core::wiki_rename::prepare(
                Path::new(&job.root),
                Path::new(&job.from),
                Path::new(&job.to),
            )
            .map_err(|e| e.to_string())?;
            if !plan.files.is_empty() || !plan.skipped.is_empty() {
                return Err("Links changed or some documents could not be checked. Preview again before completing this review.".into());
            }
        }
        self.remove_rename_job(id)
    }

    // Recovery is metadata-only. Ambiguous paths never trigger a filesystem rename or rewrite.
    pub(crate) fn pending_renames(&self) -> Result<Vec<PendingRename>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let rows = {
            let mut query = conn.prepare("SELECT id, root, old_path, new_path, phase, device, inode FROM pending_rename ORDER BY id")
                .map_err(|e| e.to_string())?;
            let rows = query
                .query_map([], |row| {
                    Ok((
                        PendingRename {
                            id: row.get(0)?,
                            root: row.get(1)?,
                            from: row.get(2)?,
                            to: row.get(3)?,
                            ready: row.get::<_, String>(4)? == "ready",
                            error: None,
                        },
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        let mut jobs = Vec::new();
        for (mut job, device, inode) in rows {
            if !job.ready {
                let recover = (|| -> Result<(), String> {
                    match std::fs::symlink_metadata(&job.from) {
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Ok(_) => return Err("The original path still exists. The interrupted rename needs manual review.".into()),
                        Err(e) => return Err(e.to_string()),
                    }
                    let new = std::fs::symlink_metadata(&job.to).map_err(|e| e.to_string())?;
                    if !new.is_file()
                        || new.dev().to_string() != device
                        || new.ino().to_string() != inode
                    {
                        return Err("The destination does not match the original document. Files were kept unchanged.".into());
                    }
                    conn.execute(
                        "UPDATE pending_rename SET phase = 'ready' WHERE id = ?1",
                        [job.id],
                    )
                    .map_err(|e| e.to_string())?;
                    Ok(())
                })();
                match recover {
                    Ok(()) => job.ready = true,
                    Err(error) => job.error = Some(error),
                }
            }
            jobs.push(job);
        }
        Ok(jobs)
    }
}

pub(crate) fn changed(app: &AppHandle) {
    if let Err(error) = app.emit("pending-renames-changed", ()) {
        tracing::warn!("이름 변경 작업 알림 실패: {error}");
    }
}

#[tauri::command]
pub async fn pending_renames(app: AppHandle) -> Result<Vec<PendingRename>, String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("Rename recovery storage is unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation_guard();
        let _files = md_core::io::document_write_guard();
        db.pending_renames()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn finish_rename_review(app: AppHandle, id: i64, discard: bool) -> Result<(), String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("Rename recovery storage is unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation_guard();
        let _files = md_core::io::document_write_guard();
        db.finish_rename_review(id, discard)?;
        changed(&app);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture {
        root: PathBuf,
        database: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "iyagi-rename-journal-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(root.join("nested")).unwrap();
            std::fs::write(root.join("old.md"), "original").unwrap();
            Self {
                database: root.join("journal.sqlite"),
                root,
            }
        }
        fn open(&self) -> StyleDb {
            let conn = Connection::open(&self.database).unwrap();
            create_schema(&conn).unwrap();
            StyleDb::test_connection(conn)
        }
        fn prepare(&self, db: &StyleDb) -> i64 {
            db.prepare_rename_job(
                self.root.to_str().unwrap(),
                self.root.join("old.md").to_str().unwrap(),
                self.root.join("new.md").to_str().unwrap(),
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn prepared_record_survives_reopen_and_recovers_only_the_original_file() {
        let f = Fixture::new();
        let db = f.open();
        let id = f.prepare(&db);
        drop(db); // Crash after the durable intent, before the rename.
        let db = f.open();
        let pending = db.pending_renames().unwrap();
        assert_eq!(pending[0].id, id);
        assert!(!pending[0].ready);
        assert!(pending[0].error.is_some());
        assert_eq!(
            std::fs::read_to_string(f.root.join("old.md")).unwrap(),
            "original"
        );
        std::fs::rename(f.root.join("old.md"), f.root.join("new.md")).unwrap();
        drop(db); // Crash after filesystem rename, before marking ready.
        let db = f.open();
        let recovered = db.pending_renames().unwrap();
        assert!(recovered[0].ready);
        assert_eq!(recovered[0].id, id);
        assert!(recovered[0].error.is_none());
        drop(db);
        assert!(f.open().rename_job(id).unwrap().ready);
        assert_eq!(
            std::fs::read_to_string(f.root.join("new.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn replaced_destination_does_not_become_a_ready_job() {
        let f = Fixture::new();
        let db = f.open();
        f.prepare(&db);
        // Keep the original inode alive, so inode reuse cannot make this fixture ambiguous.
        std::fs::rename(f.root.join("old.md"), f.root.join("elsewhere.md")).unwrap();
        std::fs::write(f.root.join("new.md"), "different").unwrap();
        let pending = db.pending_renames().unwrap();
        assert!(!pending[0].ready);
        assert!(pending[0]
            .error
            .as_ref()
            .unwrap()
            .contains("does not match"));
        assert_eq!(
            std::fs::read_to_string(f.root.join("new.md")).unwrap(),
            "different"
        );
        assert_eq!(
            std::fs::read_to_string(f.root.join("elsewhere.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn overlapping_workspace_jobs_are_rejected_until_acknowledged() {
        let f = Fixture::new();
        let db = f.open();
        let id = f.prepare(&db);
        let nested = f.root.join("nested");
        let from = nested.join("second.md");
        let to = nested.join("next.md");
        std::fs::write(&from, "second").unwrap();
        assert!(db
            .prepare_rename_job(
                nested.to_str().unwrap(),
                from.to_str().unwrap(),
                to.to_str().unwrap()
            )
            .is_err());
        db.remove_rename_job(id).unwrap();
        db.remove_rename_job(id).unwrap(); // Lost acknowledgement response is safe to retry.
        assert!(db.rename_job(id).is_err());
        assert!(db
            .prepare_rename_job(
                nested.to_str().unwrap(),
                from.to_str().unwrap(),
                to.to_str().unwrap()
            )
            .is_ok());
    }

    #[test]
    fn completion_rechecks_links_and_dismissal_only_removes_the_record() {
        let f = Fixture::new();
        let db = f.open();
        let id = f.prepare(&db);
        std::fs::rename(f.root.join("old.md"), f.root.join("new.md")).unwrap();
        db.mark_rename_ready(id).unwrap();
        std::fs::write(f.root.join("ref.md"), "[[old]]").unwrap();
        assert!(db.finish_rename_review(id, false).is_err());
        assert!(db.rename_job(id).is_ok());
        std::fs::write(f.root.join("ref.md"), "[inline](old.md#section)").unwrap();
        assert!(db.finish_rename_review(id, false).is_err());
        assert!(db.rename_job(id).is_ok());
        std::fs::write(
            f.root.join("ref.md"),
            "[reference][id]\n\n[id]: old.md \"title\"\n",
        )
        .unwrap();
        assert!(db.finish_rename_review(id, false).is_err());
        assert!(db.rename_job(id).is_ok());
        std::fs::write(f.root.join("ref.md"), "[[new]]").unwrap();
        std::fs::write(f.root.join("bad.md"), [0xff]).unwrap();
        assert!(db.finish_rename_review(id, false).is_err());
        std::fs::remove_file(f.root.join("bad.md")).unwrap();
        db.finish_rename_review(id, false).unwrap();
        db.finish_rename_review(id, false).unwrap();
        assert!(db.pending_renames().unwrap().is_empty());
        std::fs::write(f.root.join("old.md"), "another document").unwrap();
        let next = f.prepare(&db);
        assert!(db.finish_rename_review(next, false).is_err());
        db.finish_rename_review(next, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(f.root.join("old.md")).unwrap(),
            "another document"
        );
        assert_eq!(
            std::fs::read_to_string(f.root.join("new.md")).unwrap(),
            "original"
        );
    }

    #[test]
    fn failed_insert_and_failed_acknowledgement_preserve_files_and_pending_state() {
        let f = Fixture::new();
        let db = f.open();
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_intent BEFORE INSERT ON pending_rename BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        assert!(db
            .prepare_rename_job(
                f.root.to_str().unwrap(),
                f.root.join("old.md").to_str().unwrap(),
                f.root.join("new.md").to_str().unwrap()
            )
            .is_err());
        assert!(db.pending_renames().unwrap().is_empty());
        assert!(f.root.join("old.md").is_file());
        assert!(!f.root.join("new.md").exists());
        db.conn
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER reject_intent;")
            .unwrap();
        let id = f.prepare(&db);
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_ack BEFORE DELETE ON pending_rename BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        assert!(db.remove_rename_job(id).is_err());
        assert_eq!(db.pending_renames().unwrap().len(), 1);
        assert!(f.root.join("old.md").is_file());
    }
}
