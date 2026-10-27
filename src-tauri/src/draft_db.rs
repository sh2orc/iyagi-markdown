//! 작성 초안 임시저장(SQLite, 2026-10-20 요청) — 저장되지 않은 편집 내용을
//! 앱 데이터 디렉터리 `drafts.db`에 보관해 앱 재시작·크래시 뒤 복원한다.
//! **실제 `.md` 원문은 사용자가 저장(⌘S·자동 저장)할 때만 쓴다** — 초안은
//! 진실 원본이 아니라 잃을 뻔한 입력의 안전망이며, 저장·버림과 함께 지운다.
//! 키는 파일 경로와 독립적인 탭 정체성이다. 구버전의 절대경로 키도 읽는다.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use md_core::io::DocMeta;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub key: String,
    /// 실제 파일 경로(새 문서면 None — 복원 시 제목 없는 탭으로).
    pub path: Option<String>,
    pub content: String,
    pub cursor: usize,
    pub scroll: f64,
    pub updated_at: f64,
    /// 초안 작성의 기준 디스크 내용. 이전 버전 초안은 None.
    #[serde(default)]
    pub base_text: Option<String>,
    #[serde(default)]
    pub meta: Option<DocMeta>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftInfo {
    pub key: String,
    pub path: Option<String>,
    pub updated_at: f64,
}

pub struct DraftDb {
    conn: std::sync::Mutex<Connection>,
    /// 실행 중에만 유지. 다른 살아 있는 창이 쓰는 초안은 복구/수정하지 않는다.
    owners: std::sync::Mutex<HashMap<String, String>>,
}

impl DraftDb {
    pub fn open(app: &AppHandle) -> Option<Arc<Self>> {
        let dir = app.path().app_data_dir().ok()?;
        std::fs::create_dir_all(&dir).ok()?;
        Some(Arc::new(Self::open_at(&dir.join("drafts.db")).ok()?))
    }

    fn open_at(path: &Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS draft (
                 key        TEXT PRIMARY KEY,
                 path       TEXT,
                 content    TEXT NOT NULL,
                 cursor     INTEGER NOT NULL DEFAULT 0,
                 scroll     REAL NOT NULL DEFAULT 0,
                 updated_at REAL NOT NULL
             );",
        )?;
        // 기존 초안의 내용은 유지하고 필요한 열만 추가한다.
        for (name, definition) in [("base_text", "TEXT"), ("meta", "TEXT")] {
            let present: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('draft') WHERE name = ?1)",
                [name],
                |row| row.get(0),
            )?;
            if !present {
                conn.execute_batch(&format!("ALTER TABLE draft ADD COLUMN {name} {definition}"))?;
            }
        }
        Ok(Self {
            conn: std::sync::Mutex::new(conn),
            owners: std::sync::Mutex::new(HashMap::new()),
        })
    }

    fn with_owner<T>(
        &self,
        key: &str,
        owner: &str,
        live: impl FnOnce() -> HashSet<String>,
        operation: impl FnOnce() -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let mut owners = self.owners.lock().unwrap();
        let live = live();
        owners.retain(|_, label| live.contains(label));
        if !live.contains(owner) {
            return Err("The document window has closed".into());
        }
        if owners.get(key).is_some_and(|label| label != owner) {
            return Err("This recovery draft is in use by another window".into());
        }
        let value = operation().map_err(|error| error.to_string())?;
        owners.insert(key.to_owned(), owner.to_owned());
        Ok(value)
    }

    fn available(
        &self,
        owner: &str,
        live: impl FnOnce() -> HashSet<String>,
    ) -> Result<Vec<DraftInfo>, String> {
        let mut owners = self.owners.lock().unwrap();
        let live = live();
        owners.retain(|_, label| live.contains(label));
        Ok(self
            .list()
            .map_err(|error| error.to_string())?
            .into_iter()
            .filter(|draft| owners.get(&draft.key).is_none_or(|label| label == owner))
            .collect())
    }

    pub fn save(&self, d: &Draft) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO draft(key, path, content, cursor, scroll, updated_at, base_text, meta)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(key) DO UPDATE SET
               path = ?2, content = ?3, cursor = ?4, scroll = ?5, updated_at = ?6,
               base_text = ?7, meta = ?8",
            rusqlite::params![
                d.key,
                d.path,
                d.content,
                d.cursor as i64,
                d.scroll,
                d.updated_at,
                d.base_text,
                d.meta
                    .as_ref()
                    .map(|meta| serde_json::to_string(meta).expect("DocMeta serialization"))
            ],
        )?;
        Ok(())
    }

    pub fn load(&self, key: &str) -> rusqlite::Result<Option<Draft>> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT key, path, content, cursor, scroll, updated_at, base_text, meta
                 FROM draft WHERE key = ?1",
                [key],
                |r| {
                    Ok(Draft {
                        key: r.get(0)?,
                        path: r.get(1)?,
                        content: r.get(2)?,
                        cursor: r.get::<_, i64>(3)? as usize,
                        scroll: r.get(4)?,
                        updated_at: r.get(5)?,
                        base_text: r.get(6)?,
                        meta: r
                            .get::<_, Option<String>>(7)?
                            .and_then(|json| serde_json::from_str(&json).ok()),
                    })
                },
            )
            .optional()
    }

    pub fn rename_document(&self, from: &str, to: &str) -> rusqlite::Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE draft SET path = ?2 WHERE path = ?1",
            rusqlite::params![from, to],
        )?;
        Ok(())
    }

    pub fn clear(&self, key: &str) -> rusqlite::Result<usize> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM draft WHERE key = ?1", [key])
    }

    /// 세션 기록보다 초안 저장이 먼저 끝날 수 있다. 세션 밖 초안도 복구한다.
    pub fn list(&self) -> rusqlite::Result<Vec<DraftInfo>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT key, path, updated_at FROM draft ORDER BY updated_at, key")?;
        let rows = stmt.query_map([], |row| {
            Ok(DraftInfo {
                key: row.get(0)?,
                path: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })?;
        rows.collect()
    }

    /// 이미지 정리에서는 다른 창·세션의 복구 초안도 참조로 보존한다.
    /// 내용을 프런트에 노출하지 않고 백엔드 스캔에만 사용한다.
    pub fn asset_reference_texts(&self, limit: usize) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let bytes: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) FROM draft",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if bytes < 0 || bytes as u64 > limit as u64 {
            return Err("Recovery drafts exceed the image cleanup scan limit".into());
        }
        let mut stmt = conn
            .prepare("SELECT content FROM draft")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())
    }
}

// — Tauri 명령(모두 스레드 풀로 — 동기 커맨드는 메인 스레드에서 돈다) —

/// 초안 임시저장(프런트가 입력 멈춤 뒤 디바운스 호출).
#[tauri::command]
pub async fn draft_save(
    app: AppHandle,
    window: tauri::WebviewWindow,
    draft: Draft,
) -> Result<(), String> {
    let db = app.state::<crate::state::AppState>().draft_db.clone();
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(db) = db else {
            return Err("Recovery draft storage is unavailable".to_string());
        };
        db.with_owner(
            &draft.key,
            &owner,
            || app.webview_windows().into_keys().collect(),
            || db.save(&draft),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 초안 조회 — 세션 복원 시 탭별 호출.
#[tauri::command]
pub async fn draft_load(
    app: AppHandle,
    window: tauri::WebviewWindow,
    key: String,
) -> Result<Option<Draft>, String> {
    let db = app
        .state::<crate::state::AppState>()
        .draft_db
        .clone()
        .ok_or("Recovery draft storage is unavailable")?;
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        db.with_owner(
            &key,
            &owner,
            || app.webview_windows().into_keys().collect(),
            || db.load(&key),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 초안 삭제 — 저장(⌘S·자동 저장)·탭 버림 때.
#[tauri::command]
pub async fn draft_clear(
    app: AppHandle,
    window: tauri::WebviewWindow,
    key: String,
) -> Result<(), String> {
    let db = app.state::<crate::state::AppState>().draft_db.clone();
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(db) = db else {
            return Err("Recovery draft storage is unavailable".to_string());
        };
        db.with_owner(
            &key,
            &owner,
            || app.webview_windows().into_keys().collect(),
            || db.clear(&key).map(|_| ()),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 본문은 목록 조회 시 가져오지 않는다. 프런트가 순서대로 필요한 초안을 읽는다.
#[tauri::command]
pub async fn draft_list(
    app: AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Vec<DraftInfo>, String> {
    let db = app
        .state::<crate::state::AppState>()
        .draft_db
        .clone()
        .ok_or("Recovery draft storage is unavailable")?;
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        db.available(&owner, || app.webview_windows().into_keys().collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(tag: &str) -> DraftDb {
        DraftDb::open_at(
            &std::env::temp_dir().join(format!("iyagi-draft-{tag}-{}.db", std::process::id())),
        )
        .unwrap()
    }

    fn draft(key: &str, content: &str) -> Draft {
        Draft {
            key: key.into(),
            path: if key.starts_with("untitled:") {
                None
            } else {
                Some(key.into())
            },
            content: content.into(),
            cursor: 7,
            scroll: 42.5,
            updated_at: 1000.0,
            base_text: Some("disk baseline".into()),
            meta: Some(DocMeta {
                had_bom: true,
                crlf: true,
            }),
        }
    }

    #[test]
    fn roundtrip_upsert_clear() {
        let d = db("rt");
        d.save(&draft("/tmp/a.md", "v1")).unwrap();
        assert_eq!(d.load("/tmp/a.md").unwrap().unwrap().content, "v1");
        // 같은 키 upsert — 행이 늘지 않고 내용만 바뀐다.
        d.save(&draft("/tmp/a.md", "v2")).unwrap();
        assert_eq!(d.load("/tmp/a.md").unwrap().unwrap().content, "v2");
        let n: i64 = d
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM draft", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        assert!(d.load("없는키").unwrap().is_none());
        d.clear("/tmp/a.md").unwrap();
        assert!(d.load("/tmp/a.md").unwrap().is_none());
    }

    #[test]
    fn cleanup_references_include_untitled_and_named_drafts_with_a_byte_limit() {
        let d = DraftDb::open_at(Path::new(":memory:")).unwrap();
        d.save(&draft("untitled:one", "미저장.png")).unwrap();
        d.save(&draft("/tmp/a.md", "saved-draft.png")).unwrap();
        let texts = d.asset_reference_texts(1024).unwrap();
        assert_eq!(texts.len(), 2);
        assert!(texts.iter().any(|text| text == "미저장.png"));
        assert!(texts.iter().any(|text| text == "saved-draft.png"));
        assert!(d.asset_reference_texts(1).is_err());
    }

    #[test]
    fn opening_legacy_database_adds_columns_without_losing_drafts() {
        let path =
            std::env::temp_dir().join(format!("iyagi-draft-migration-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE draft (
                key TEXT PRIMARY KEY, path TEXT, content TEXT NOT NULL,
                cursor INTEGER NOT NULL, scroll REAL NOT NULL, updated_at REAL NOT NULL);
                INSERT INTO draft VALUES ('untitled:legacy', NULL, 'keep me', 3, 4, 5);",
            )
            .unwrap();
        }
        {
            let db = DraftDb::open_at(&path).unwrap();
            let old = db.load("untitled:legacy").unwrap().unwrap();
            assert_eq!(old.content, "keep me");
            assert!(old.base_text.is_none());
            assert!(old.meta.is_none());
            db.save(&draft("untitled:new", "new text")).unwrap();
            assert_eq!(db.list().unwrap().len(), 2);
        }
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn list_preserves_drafts_outside_the_session() {
        let d = DraftDb::open_at(Path::new(":memory:")).unwrap();
        d.save(&draft("/tmp/keep.md", "a")).unwrap();
        d.save(&draft("untitled:orphan", "")).unwrap();
        assert_eq!(d.list().unwrap().len(), 2);
        let restored = d.load("untitled:orphan").unwrap().unwrap();
        assert_eq!(restored.content, "");
        assert_eq!(restored.base_text.as_deref(), Some("disk baseline"));
        assert!(restored.meta.unwrap().had_bom);
    }

    #[test]
    fn live_owner_prevents_other_windows_from_loading_writing_or_deleting() {
        let db = DraftDb::open_at(Path::new(":memory:")).unwrap();
        let both = || HashSet::from(["main".to_owned(), "doc-1".to_owned()]);
        let first = draft("document:first", "first window");
        db.with_owner(&first.key, "doc-1", both, || db.save(&first))
            .unwrap();
        assert!(db.available("main", both).unwrap().is_empty());
        assert!(db
            .with_owner(&first.key, "main", both, || db.load(&first.key))
            .is_err());
        assert!(db
            .with_owner(&first.key, "main", both, || db.clear(&first.key))
            .is_err());
        assert!(db
            .with_owner(&first.key, "main", both, || db
                .save(&draft(&first.key, "other window")))
            .is_err());
        assert_eq!(
            db.load(&first.key).unwrap().unwrap().content,
            "first window"
        );
        let only_main = || HashSet::from(["main".to_owned()]);
        assert_eq!(db.available("main", only_main).unwrap().len(), 1);
        assert!(db
            .with_owner(&first.key, "doc-1", only_main, || db.clear(&first.key))
            .is_err());
        assert!(db
            .with_owner(&first.key, "main", only_main, || db.load(&first.key))
            .unwrap()
            .is_some());
    }

    #[test]
    fn rename_preserves_all_variant_keys_and_clear_removes_only_one() {
        let db = DraftDb::open_at(Path::new(":memory:")).unwrap();
        for (key, text) in [
            ("document:first", "first"),
            ("document:second", "second"),
            ("/old.md", "legacy"),
        ] {
            let mut item = draft(key, text);
            item.path = Some("/old.md".into());
            db.save(&item).unwrap();
        }
        db.rename_document("/old.md", "/new.md").unwrap();
        assert_eq!(db.list().unwrap().len(), 3);
        for key in ["document:first", "document:second", "/old.md"] {
            assert_eq!(
                db.load(key).unwrap().unwrap().path.as_deref(),
                Some("/new.md")
            );
        }
        db.clear("document:first").unwrap();
        assert_eq!(
            db.load("document:second").unwrap().unwrap().content,
            "second"
        );
        assert_eq!(db.load("/old.md").unwrap().unwrap().content, "legacy");
    }
}
