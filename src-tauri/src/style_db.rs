//! 문서별 스타일 저장(SQLite, 2026-10-11 요청) — `.md` 원문은 절대 건드리지
//! 않고(§4-2) 글꼴·크기·행간·간격 같은 **스타일 정보만** 문서 경로를 키로
//! 사이드카 저장한다. 앱 데이터 디렉터리의 styles.db.

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

pub struct StyleDb {
    conn: std::sync::Mutex<Connection>,
}

impl StyleDb {
    pub fn open(app: &AppHandle) -> Option<Self> {
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
        Some(Self { conn: std::sync::Mutex::new(conn) })
    }
}

/// 문서의 저장된 스타일(JSON 문자열). 없으면 null.
#[tauri::command]
pub fn doc_style_get(state: State<'_, AppState>, path: String) -> Option<String> {
    let db = state.style_db.as_ref()?;
    let conn = db.conn.lock().unwrap();
    conn.query_row(
        "SELECT style_json FROM doc_style WHERE path = ?1",
        [&path],
        |row| row.get(0),
    )
    .ok()
}

/// 문서 스타일 저장(덮어쓰기). 원문 파일은 전혀 수정하지 않는다.
#[tauri::command]
pub fn doc_style_set(state: State<'_, AppState>, path: String, style_json: String) -> Result<(), String> {
    let db = state.style_db.as_ref().ok_or("스타일 저장소를 열 수 없습니다")?;
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
}

/// 문서 스타일 삭제(기본으로 되돌리기).
#[tauri::command]
pub fn doc_style_clear(state: State<'_, AppState>, path: String) -> Result<(), String> {
    if let Some(db) = state.style_db.as_ref() {
        db.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM doc_style WHERE path = ?1", [&path])
            .map(|_| ())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
