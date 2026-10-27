//! 문서별 스타일 저장(SQLite, 2026-10-11 요청) — `.md` 원문은 절대 건드리지
//! 않고(§4-2) 글꼴·크기·행간·간격 같은 **스타일 정보만** 문서 경로를 키로
//! 사이드카 저장한다. 앱 데이터 디렉터리의 styles.db.

use std::sync::Arc;

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub struct StyleDb {
    pub(crate) conn: std::sync::Mutex<Connection>,
    baseline_revision: std::sync::atomic::AtomicU64,
    bookmark_revision: std::sync::atomic::AtomicU64,
}

impl StyleDb {
    #[cfg(test)]
    pub(crate) fn test_connection(conn: Connection) -> Self {
        crate::favorites::create_schema(&conn).unwrap();
        crate::user_templates::create_schema(&conn).unwrap();
        crate::workspace_history::create_schema(&conn).unwrap();
        Self {
            conn: std::sync::Mutex::new(conn),
            baseline_revision: std::sync::atomic::AtomicU64::new(0),
            bookmark_revision: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// 문서 정체성에 속하는 모든 사이드카를 한 트랜잭션으로 옮긴다.
    /// 새 경로에 기존 정보가 있으면 덮어쓰지 않고 원래 정보를 보존한다.
    pub fn rename_document(&self, from: &str, to: &str) -> rusqlite::Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        for table in [
            "doc_style",
            "doc_bookmark",
            "doc_bookmark_context",
            "doc_baseline",
            "doc_comment",
        ] {
            let occupied: bool = tx.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE path = ?1)"),
                [to],
                |row| row.get(0),
            )?;
            if occupied {
                return Err(rusqlite::Error::InvalidQuery);
            }
            tx.execute(
                &format!("UPDATE {table} SET path = ?2 WHERE path = ?1"),
                rusqlite::params![from, to],
            )?;
        }
        crate::favorites::rename(&tx, from, to)?;
        tx.commit()
    }

    pub fn open(app: &AppHandle) -> Option<Arc<Self>> {
        let dir = app.path().app_data_dir().ok()?;
        std::fs::create_dir_all(&dir).ok()?;
        let conn = Connection::open(dir.join("styles.db")).ok()?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS doc_style (
                 path        TEXT PRIMARY KEY,
                 style_json  TEXT NOT NULL,
                 updated_at  REAL NOT NULL
             );
             CREATE TABLE IF NOT EXISTS doc_bookmark (
                 path       TEXT NOT NULL,
                 line_no    INTEGER NOT NULL,
                 created_at REAL NOT NULL,
                 PRIMARY KEY (path, line_no)
             );
             CREATE TABLE IF NOT EXISTS doc_bookmark_context (
                 path TEXT PRIMARY KEY,
                 text TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS doc_baseline (
                 path       TEXT PRIMARY KEY,
                 text       TEXT NOT NULL,
                 updated_at REAL NOT NULL
             );
             CREATE TABLE IF NOT EXISTS doc_comment (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 path       TEXT NOT NULL,
                 line_no    INTEGER NOT NULL,
                 text       TEXT NOT NULL,
                 created_at REAL NOT NULL,
                 resolved   INTEGER NOT NULL DEFAULT 0
             );",
        )
        .ok()?;
        crate::rename_jobs::create_schema(&conn).ok()?;
        crate::favorites::create_schema(&conn).ok()?;
        crate::user_templates::create_schema(&conn).ok()?;
        crate::workspace_history::create_schema(&conn).ok()?;
        Some(Arc::new(Self {
            conn: std::sync::Mutex::new(conn),
            baseline_revision: std::sync::atomic::AtomicU64::new(0),
            bookmark_revision: std::sync::atomic::AtomicU64::new(0),
        }))
    }
}

/// 문서의 저장된 스타일(JSON 문자열). 없으면 null.
#[tauri::command]
pub async fn doc_style_get(app: AppHandle, path: String) -> Result<Option<String>, String> {
    // SQLite 조회도 스레드 풀로 — 동기 커맨드는 앱 메인 스레드에서 돈다.
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("스타일 저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT style_json FROM doc_style WHERE path = ?1",
            [&path],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 문서 스타일 저장(덮어쓰기). 원문 파일은 전혀 수정하지 않는다.
#[tauri::command]
pub async fn doc_style_set(app: AppHandle, path: String, style_json: String) -> Result<(), String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("스타일 저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO doc_style (path, style_json, updated_at) VALUES (?1, ?2, unixepoch())
                 ON CONFLICT(path) DO UPDATE SET style_json = excluded.style_json, updated_at = excluded.updated_at",
                rusqlite::params![path, style_json],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 문서 스타일 삭제(기본으로 되돌리기).
#[tauri::command]
pub async fn doc_style_clear(app: AppHandle, path: String) -> Result<(), String> {
    let db = app.state::<crate::state::AppState>().style_db.clone();
    if let Some(db) = db {
        tauri::async_runtime::spawn_blocking(move || {
            db.conn
                .lock()
                .unwrap()
                .execute("DELETE FROM doc_style WHERE path = ?1", [&path])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(())
}

/// 줄 번호는 항상 text 본문을 기준으로 한다. 실패·재시작 뒤에도 기준을 잃지 않는다.
#[derive(Clone, Debug, Serialize)]
pub struct BookmarkSnapshot {
    lines: Vec<i64>,
    text: String,
    revision: u64,
}

#[derive(Deserialize)]
pub struct BookmarkExpectation {
    lines: Vec<i64>,
    text: String,
}

impl StyleDb {
    fn ensure_bookmark_context(&self, conn: &Connection, path: &str) -> Result<(), String> {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM doc_bookmark_context WHERE path = ?1)",
                [path],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            // 이전 DB에는 기준 본문이 없다. 최초 조회 당시 저장된 본문으로 한 번만 이관한다.
            let doc =
                md_core::io::read_doc(std::path::Path::new(path)).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO doc_bookmark_context(path, text) VALUES (?1, ?2)",
                rusqlite::params![path, doc.text],
            )
            .map_err(|e| e.to_string())?;
            self.bookmark_revision
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(())
    }

    fn bookmark_snapshot(&self, conn: &Connection, path: &str) -> Result<BookmarkSnapshot, String> {
        let text = conn
            .query_row(
                "SELECT text FROM doc_bookmark_context WHERE path = ?1",
                [path],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT line_no FROM doc_bookmark WHERE path = ?1 ORDER BY line_no")
            .map_err(|e| e.to_string())?;
        let lines = stmt
            .query_map([path], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<i64>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(BookmarkSnapshot {
            text,
            lines,
            revision: self
                .bookmark_revision
                .load(std::sync::atomic::Ordering::Relaxed),
        })
    }

    fn bookmarks(&self, path: &str) -> Result<BookmarkSnapshot, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.ensure_bookmark_context(&conn, path)?;
        self.bookmark_snapshot(&conn, path)
    }

    fn set_bookmark(
        &self,
        path: &str,
        line: i64,
        present: bool,
        expected_text: &str,
    ) -> Result<BookmarkSnapshot, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.ensure_bookmark_context(&conn, path)?;
        let current = self.bookmark_snapshot(&conn, path)?;
        if current.text != expected_text {
            return Err("Bookmark positions changed. Reload bookmarks and try again.".into());
        }
        if line < 1 || (present && line as usize > current.text.split('\n').count()) {
            return Err("Invalid bookmark line".into());
        }
        let changed = if present {
            conn.execute("INSERT OR IGNORE INTO doc_bookmark(path, line_no, created_at) VALUES (?1, ?2, unixepoch())", rusqlite::params![path, line])
        } else {
            conn.execute("DELETE FROM doc_bookmark WHERE path = ?1 AND line_no = ?2", rusqlite::params![path, line])
        }.map_err(|e| e.to_string())?;
        if changed > 0 {
            self.bookmark_revision
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        self.bookmark_snapshot(&conn, path)
    }

    fn replace_bookmarks(
        &self,
        path: &str,
        text: String,
        mut lines: Vec<i64>,
        expected: &BookmarkExpectation,
    ) -> Result<BookmarkSnapshot, String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        self.ensure_bookmark_context(&conn, path)?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let current = self.bookmark_snapshot(&tx, path)?;
        if current.text != expected.text || current.lines != expected.lines {
            return Err("Bookmarks changed in another window. Reload bookmarks before moving their positions.".into());
        }
        lines.sort_unstable();
        lines.dedup();
        let max_line = text.split('\n').count();
        if lines
            .iter()
            .any(|line| *line < 1 || *line as usize > max_line)
        {
            return Err("Invalid bookmark line".into());
        }
        let changed = current.text != text || current.lines != lines;
        if changed {
            tx.execute("DELETE FROM doc_bookmark WHERE path = ?1", [path])
                .map_err(|e| e.to_string())?;
            for line in &lines {
                tx.execute("INSERT INTO doc_bookmark(path, line_no, created_at) VALUES (?1, ?2, unixepoch())", rusqlite::params![path, line])
                    .map_err(|e| e.to_string())?;
            }
            tx.execute(
                "UPDATE doc_bookmark_context SET text = ?2 WHERE path = ?1",
                rusqlite::params![path, text],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        if changed {
            self.bookmark_revision
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(BookmarkSnapshot {
            text,
            lines,
            revision: self
                .bookmark_revision
                .load(std::sync::atomic::Ordering::Relaxed),
        })
    }
}

fn bookmarks_changed(app: &AppHandle, path: &str) {
    if let Err(error) = app.emit("bookmarks-changed", path) {
        tracing::warn!("책갈피 변경 알림 실패: {error}");
    }
}

#[tauri::command]
pub async fn bookmark_list(app: AppHandle, path: String) -> Result<BookmarkSnapshot, String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("책갈피 저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || db.bookmarks(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn bookmark_set(
    app: AppHandle,
    path: String,
    line_no: i64,
    present: bool,
    expected_text: String,
) -> Result<BookmarkSnapshot, String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("책갈피 저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = db.set_bookmark(&path, line_no, present, &expected_text)?;
        bookmarks_changed(&app, &path);
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn bookmark_replace(
    app: AppHandle,
    path: String,
    text: String,
    lines: Vec<i64>,
    expected: BookmarkExpectation,
) -> Result<BookmarkSnapshot, String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("책갈피 저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || {
        // 재시도 대상이 다른 창의 최신 파일보다 오래됐으면 앵커를 이동하지 않는다.
        let guard = md_core::io::document_write_guard();
        let disk = md_core::io::read_doc(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
        if disk.text != text {
            return Err("The document changed on disk. Reload it before moving bookmarks.".into());
        }
        let snapshot = db.replace_bookmarks(&path, text, lines, &expected)?;
        drop(guard);
        bookmarks_changed(&app, &path);
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 문서 메모 — 문서 경로와 기존 내용을 함께 비교해 오래된 편집을 거절한다.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocComment {
    pub id: i64,
    pub line_no: i64,
    pub text: String,
    pub created_at: f64,
    pub resolved: bool,
}

#[derive(Deserialize)]
pub struct CommentExpectation {
    pub text: String,
    pub resolved: bool,
}

fn comment_text(text: &str) -> Result<&str, String> {
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 20_000 {
        return Err("Comment must contain 1–20,000 characters".into());
    }
    Ok(text)
}

fn comment_changed(count: usize) -> Result<(), String> {
    if count != 1 {
        return Err(
            "This comment was changed, moved, or deleted. Reload the comments before trying again."
                .into(),
        );
    }
    Ok(())
}

impl StyleDb {
    fn comments(&self, path: &str) -> Result<Vec<DocComment>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, line_no, text, created_at, resolved FROM doc_comment WHERE path = ?1 ORDER BY line_no, id",
        ).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([path], |row| {
                Ok(DocComment {
                    id: row.get(0)?,
                    line_no: row.get(1)?,
                    text: row.get(2)?,
                    created_at: row.get(3)?,
                    resolved: row.get::<_, i64>(4)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    fn add_comment(&self, path: &str, line_no: i64, text: &str) -> Result<i64, String> {
        let text = comment_text(text)?;
        if path.is_empty() || line_no < 1 {
            return Err("Invalid comment location".into());
        }
        // INSERT와 rowid 조회가 하나의 잠금을 공유한다. 중첩 잠금도 피한다.
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO doc_comment (path, line_no, text, created_at) VALUES (?1, ?2, ?3, unixepoch())",
            rusqlite::params![path, line_no, text],
        ).map_err(|e| e.to_string())?;
        Ok(conn.last_insert_rowid())
    }

    fn edit_comment(
        &self,
        path: &str,
        id: i64,
        text: &str,
        expected: &CommentExpectation,
    ) -> Result<(), String> {
        let text = comment_text(text)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        comment_changed(conn.execute(
            "UPDATE doc_comment SET text = ?3 WHERE path = ?1 AND id = ?2 AND text = ?4 AND resolved = ?5",
            rusqlite::params![path, id, text, expected.text, expected.resolved],
        ).map_err(|e| e.to_string())?)
    }

    fn resolve_comment(
        &self,
        path: &str,
        id: i64,
        resolved: bool,
        expected: &CommentExpectation,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        comment_changed(conn.execute(
            "UPDATE doc_comment SET resolved = ?3 WHERE path = ?1 AND id = ?2 AND text = ?4 AND resolved = ?5",
            rusqlite::params![path, id, resolved, expected.text, expected.resolved],
        ).map_err(|e| e.to_string())?)
    }

    fn remove_comment(
        &self,
        path: &str,
        id: i64,
        expected: &CommentExpectation,
    ) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        comment_changed(conn.execute(
            "DELETE FROM doc_comment WHERE path = ?1 AND id = ?2 AND text = ?3 AND resolved = ?4",
            rusqlite::params![path, id, expected.text, expected.resolved],
        ).map_err(|e| e.to_string())?)
    }
}

fn comments_changed(app: &AppHandle, path: &str) {
    if let Err(error) = app.emit("comments-changed", path) {
        tracing::warn!("메모 변경 알림 실패: {error}");
    }
}

#[tauri::command]
pub async fn comment_list(app: AppHandle, path: String) -> Result<Vec<DocComment>, String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("메모 저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || db.comments(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn comment_add(
    app: AppHandle,
    path: String,
    line_no: i64,
    text: String,
) -> Result<i64, String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("메모 저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || {
        let id = db.add_comment(&path, line_no, &text)?;
        comments_changed(&app, &path);
        Ok(id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn comment_update(
    app: AppHandle,
    path: String,
    id: i64,
    text: String,
    expected: CommentExpectation,
) -> Result<(), String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("메모 저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || {
        db.edit_comment(&path, id, &text, &expected)?;
        comments_changed(&app, &path);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn comment_resolve(
    app: AppHandle,
    path: String,
    id: i64,
    resolved: bool,
    expected: CommentExpectation,
) -> Result<(), String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("메모 저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || {
        db.resolve_comment(&path, id, resolved, &expected)?;
        comments_changed(&app, &path);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn comment_remove(
    app: AppHandle,
    path: String,
    id: i64,
    expected: CommentExpectation,
) -> Result<(), String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("메모 저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || {
        db.remove_comment(&path, id, &expected)?;
        comments_changed(&app, &path);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 기준 본문과 순번은 같은 DB 잠금 안에서 읽고 갱신한다.
#[derive(Clone, Debug, Serialize)]
pub struct BaselineSnapshot {
    text: Option<String>,
    revision: u64,
}

#[derive(Deserialize)]
pub struct BaselineExpectation {
    text: Option<String>,
}

impl StyleDb {
    fn baseline(&self, path: &str) -> Result<BaselineSnapshot, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let text = conn
            .query_row(
                "SELECT text FROM doc_baseline WHERE path = ?1",
                [path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(BaselineSnapshot {
            text,
            revision: self
                .baseline_revision
                .load(std::sync::atomic::Ordering::Relaxed),
        })
    }

    fn write_baseline(
        &self,
        path: &str,
        text: Option<String>,
        expected: &BaselineExpectation,
    ) -> Result<BaselineSnapshot, String> {
        if path.is_empty() {
            return Err("Invalid document path".into());
        }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let current: Option<String> = tx
            .query_row(
                "SELECT text FROM doc_baseline WHERE path = ?1",
                [path],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if current != expected.text {
            return Err("The tracking baseline changed in another window. Reload tracked changes before trying again.".into());
        }
        if current != text {
            match &text {
                Some(text) => {
                    tx.execute(
                    "INSERT INTO doc_baseline (path, text, updated_at) VALUES (?1, ?2, unixepoch())
                     ON CONFLICT(path) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
                    rusqlite::params![path, text],
                ).map_err(|e| e.to_string())?;
                }
                None => {
                    tx.execute("DELETE FROM doc_baseline WHERE path = ?1", [path])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        if current != text {
            self.baseline_revision
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(BaselineSnapshot {
            text,
            revision: self
                .baseline_revision
                .load(std::sync::atomic::Ordering::Relaxed),
        })
    }
}

#[tauri::command]
pub async fn baseline_get(app: AppHandle, path: String) -> Result<BaselineSnapshot, String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || db.baseline(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn baseline_write(
    app: AppHandle,
    path: String,
    text: Option<String>,
    expected: BaselineExpectation,
) -> Result<BaselineSnapshot, String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = db.write_baseline(&path, text, &expected)?;
        if let Err(error) = app.emit("baseline-changed", &path) {
            tracing::warn!("변경 추적 알림 실패: {error}");
        }
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 메모 줄 재앵커 — 저장 시 diff 보정된 (id → 새 줄) 일괄 적용.
#[tauri::command]
pub async fn comment_reanchor(
    app: AppHandle,
    path: String,
    updates: Vec<(i64, i64)>,
) -> Result<(), String> {
    let db = app
        .state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or("저장소를 열 수 없습니다")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = db.conn.lock().unwrap();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (id, line) in updates {
            tx.execute(
                "UPDATE doc_comment SET line_no = ?2 WHERE id = ?1 AND path = ?3",
                rusqlite::params![id, line, path],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        comments_changed(&app, &path);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod comment_tests {
    use super::*;

    fn database() -> StyleDb {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE doc_comment (
            id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, line_no INTEGER NOT NULL,
            text TEXT NOT NULL, created_at REAL NOT NULL, resolved INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE doc_bookmark (path TEXT NOT NULL, line_no INTEGER NOT NULL, created_at REAL NOT NULL, PRIMARY KEY(path, line_no));
        CREATE TABLE doc_bookmark_context (path TEXT PRIMARY KEY, text TEXT NOT NULL);
        INSERT INTO doc_bookmark_context(path, text) VALUES ('/doc.md', 'a'||char(10)||'b'||char(10)||'c');
        CREATE TABLE doc_baseline (path TEXT PRIMARY KEY, text TEXT NOT NULL, updated_at REAL NOT NULL);").unwrap();
        StyleDb {
            conn: std::sync::Mutex::new(conn),
            baseline_revision: std::sync::atomic::AtomicU64::new(0),
            bookmark_revision: std::sync::atomic::AtomicU64::new(0),
        }
    }

    #[test]
    fn bookmark_set_is_idempotent_and_rejects_changed_context() {
        let db = database();
        let added = db.set_bookmark("/doc.md", 2, true, "a\nb\nc").unwrap();
        let repeated = db.set_bookmark("/doc.md", 2, true, "a\nb\nc").unwrap();
        assert_eq!(repeated.lines, vec![2]);
        assert_eq!(repeated.revision, added.revision);
        assert!(db.set_bookmark("/doc.md", 2, false, "outdated").is_err());
        assert!(db.set_bookmark("/doc.md", 0, true, "a\nb\nc").is_err());
        assert!(db.set_bookmark("/doc.md", 4, true, "a\nb\nc").is_err());
        assert_eq!(db.bookmarks("/doc.md").unwrap().lines, vec![2]);
    }

    #[test]
    fn bookmark_replace_rejects_another_windows_changes() {
        let db = database();
        let first = db.set_bookmark("/doc.md", 2, true, "a\nb\nc").unwrap();
        db.set_bookmark("/doc.md", 3, true, "a\nb\nc").unwrap();
        let expected = BookmarkExpectation {
            text: first.text,
            lines: first.lines,
        };
        assert!(db
            .replace_bookmarks("/doc.md", "intro\na\nb\nc".into(), vec![3], &expected)
            .is_err());
        let kept = db.bookmarks("/doc.md").unwrap();
        assert_eq!(kept.lines, vec![2, 3]);
        assert_eq!(kept.text, "a\nb\nc");
        let expected = BookmarkExpectation {
            text: kept.text,
            lines: kept.lines,
        };
        let moved = db
            .replace_bookmarks("/doc.md", "intro\na\nb\nc".into(), vec![4, 3, 3], &expected)
            .unwrap();
        assert_eq!(moved.lines, vec![3, 4]);
        assert!(db.set_bookmark("/doc.md", 2, false, "a\nb\nc").is_err());
    }

    #[test]
    fn bookmark_failure_rolls_back_both_lines_and_context() {
        let db = database();
        let before = db.set_bookmark("/doc.md", 2, true, "a\nb\nc").unwrap();
        db.conn.lock().unwrap().execute_batch("CREATE TRIGGER reject_context BEFORE UPDATE ON doc_bookmark_context BEGIN SELECT RAISE(ABORT, 'disk full'); END;").unwrap();
        let expected = BookmarkExpectation {
            text: before.text.clone(),
            lines: before.lines.clone(),
        };
        assert!(db
            .replace_bookmarks("/doc.md", "intro\na\nb\nc".into(), vec![3], &expected)
            .is_err());
        let kept = db.bookmarks("/doc.md").unwrap();
        assert_eq!(kept.lines, before.lines);
        assert_eq!(kept.text, before.text);
        assert_eq!(kept.revision, before.revision);
        db.conn
            .lock()
            .unwrap()
            .execute_batch("DROP TABLE doc_bookmark;")
            .unwrap();
        assert!(db.bookmarks("/doc.md").is_err());
    }

    fn expected(text: &str, resolved: bool) -> CommentExpectation {
        CommentExpectation {
            text: text.into(),
            resolved,
        }
    }

    #[test]
    fn baseline_compare_write_preserves_other_windows_and_empty_text() {
        let db = database();
        let first = db
            .write_baseline(
                "/doc.md",
                Some(String::new()),
                &BaselineExpectation { text: None },
            )
            .unwrap();
        assert_eq!(first.text, Some(String::new()));
        assert_eq!(first.revision, 1);
        assert!(db
            .write_baseline(
                "/doc.md",
                Some("stale start".into()),
                &BaselineExpectation { text: None }
            )
            .is_err());
        let next = db
            .write_baseline(
                "/doc.md",
                Some("latest".into()),
                &BaselineExpectation {
                    text: Some(String::new()),
                },
            )
            .unwrap();
        assert_eq!(next.revision, 2);
        assert!(db
            .write_baseline(
                "/doc.md",
                None,
                &BaselineExpectation {
                    text: Some(String::new())
                }
            )
            .is_err());
        assert_eq!(
            db.baseline("/doc.md").unwrap().text.as_deref(),
            Some("latest")
        );
        let cleared = db
            .write_baseline(
                "/doc.md",
                None,
                &BaselineExpectation {
                    text: Some("latest".into()),
                },
            )
            .unwrap();
        assert_eq!(cleared.text, None);
        assert_eq!(cleared.revision, 3);
    }

    #[test]
    fn baseline_failure_preserves_value_and_revision_and_read_errors() {
        let db = database();
        db.write_baseline(
            "/doc.md",
            Some("original".into()),
            &BaselineExpectation { text: None },
        )
        .unwrap();
        db.conn.lock().unwrap().execute_batch(
            "CREATE TRIGGER reject_baseline BEFORE UPDATE ON doc_baseline BEGIN SELECT RAISE(ABORT, 'blocked'); END;",
        ).unwrap();
        assert!(db
            .write_baseline(
                "/doc.md",
                Some("new".into()),
                &BaselineExpectation {
                    text: Some("original".into())
                }
            )
            .is_err());
        let saved = db.baseline("/doc.md").unwrap();
        assert_eq!(saved.text.as_deref(), Some("original"));
        assert_eq!(saved.revision, 1);
        db.conn
            .lock()
            .unwrap()
            .execute("DROP TABLE doc_baseline", [])
            .unwrap();
        assert!(db.baseline("/doc.md").is_err());
    }

    #[test]
    fn insert_returns_the_id_for_its_own_text_without_relocking() {
        let db = Arc::new(database());
        let workers: Vec<_> = ["first", "second"]
            .into_iter()
            .map(|text| {
                let db = db.clone();
                std::thread::spawn(move || (db.add_comment("/doc.md", 1, text).unwrap(), text))
            })
            .collect();
        let ids: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let rows = db.comments("/doc.md").unwrap();
        assert_ne!(ids[0].0, ids[1].0);
        for (id, text) in ids {
            assert_eq!(rows.iter().find(|row| row.id == id).unwrap().text, text);
        }
    }

    #[test]
    fn stale_edits_and_deletes_cannot_overwrite_another_window() {
        let db = database();
        let id = db.add_comment("/doc.md", 2, "original").unwrap();
        db.edit_comment("/doc.md", id, "new", &expected("original", false))
            .unwrap();
        assert!(db
            .edit_comment("/doc.md", id, "stale", &expected("original", false))
            .is_err());
        assert!(db
            .remove_comment("/doc.md", id, &expected("original", false))
            .is_err());
        db.resolve_comment("/doc.md", id, true, &expected("new", false))
            .unwrap();
        assert!(db
            .edit_comment("/doc.md", id, "stale status", &expected("new", false))
            .is_err());
        let row = db.comments("/doc.md").unwrap().remove(0);
        assert_eq!(row.text, "new");
        assert!(row.resolved);
        db.remove_comment("/doc.md", id, &expected("new", true))
            .unwrap();
        assert!(db
            .remove_comment("/doc.md", id, &expected("new", true))
            .is_err());
    }

    #[test]
    fn matching_id_cannot_modify_a_different_document() {
        let db = database();
        let id = db.add_comment("/a.md", 1, "memo").unwrap();
        assert!(db
            .edit_comment("/b.md", id, "wrong", &expected("memo", false))
            .is_err());
        assert!(db
            .resolve_comment("/b.md", id, true, &expected("memo", false))
            .is_err());
        assert!(db
            .remove_comment("/b.md", id, &expected("memo", false))
            .is_err());
        assert_eq!(db.comments("/a.md").unwrap().len(), 1);
    }

    #[test]
    fn invalid_input_and_database_failure_are_not_empty_successes() {
        let db = database();
        assert!(db.add_comment("/doc.md", 0, "memo").is_err());
        assert!(db.add_comment("/doc.md", 1, "  ").is_err());
        assert!(db.add_comment("/doc.md", 1, &"x".repeat(20_001)).is_err());
        db.conn
            .lock()
            .unwrap()
            .execute("DROP TABLE doc_comment", [])
            .unwrap();
        assert!(db.comments("/doc.md").is_err());
    }
}
