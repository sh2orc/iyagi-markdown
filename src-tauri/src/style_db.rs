//! 문서별 스타일 저장(SQLite, 2026-10-11 요청) — `.md` 원문은 절대 건드리지
//! 않고(§4-2) 글꼴·크기·행간·간격 같은 **스타일 정보만** 문서 경로를 키로
//! 사이드카 저장한다. 앱 데이터 디렉터리의 styles.db.

use std::sync::Arc;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

pub struct StyleDb {
    conn: std::sync::Mutex<Connection>,
}

impl StyleDb {
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
             );",
        )
        .ok()?;
        Some(Arc::new(Self { conn: std::sync::Mutex::new(conn) }))
    }
}

/// 문서의 저장된 스타일(JSON 문자열). 없으면 null.
#[tauri::command]
pub async fn doc_style_get(app: AppHandle, path: String) -> Option<String> {
    // SQLite 조회도 스레드 풀로 — 동기 커맨드는 앱 메인 스레드에서 돈다.
    let db = app.state::<crate::state::AppState>().style_db.clone()?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT style_json FROM doc_style WHERE path = ?1",
            [&path],
            |row| row.get(0),
        )
        .ok()
    })
    .await
    .ok()
    .flatten()
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
