//! Reusable Markdown snapshots, independent of their source documents.
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) const MAX_TEMPLATES: i64 = 100;
const MAX_CONTENT: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInfo {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) version: i64,
}
#[derive(Debug, Serialize)]
pub struct Template {
    #[serde(flatten)]
    pub(crate) info: TemplateInfo,
    pub(crate) content: String,
}
#[derive(Debug, Serialize)]
pub struct TemplateList {
    revision: i64,
    templates: Vec<TemplateInfo>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateInput {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) content: String,
    pub(crate) expected_version: Option<i64>,
}
#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum TemplateError {
    Invalid,
    TooLarge,
    Limit,
    Changed,
    Missing,
    ArchiveInvalid,
    ArchiveTooLarge,
    Io(String),
}
impl From<rusqlite::Error> for TemplateError {
    fn from(value: rusqlite::Error) -> Self {
        Self::Io(value.to_string())
    }
}

pub(crate) fn create_schema(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS user_template (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        content TEXT NOT NULL, version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_templates_state (
        id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deleted_user_template (id TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO user_templates_state VALUES(1, 0);",
    )?;
    tx.commit()
}
pub(crate) fn revision(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT revision FROM user_templates_state WHERE id = 1",
        [],
        |row| row.get(0),
    )
}
fn info(row: &rusqlite::Row<'_>) -> rusqlite::Result<TemplateInfo> {
    Ok(TemplateInfo {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        version: row.get(3)?,
    })
}
fn list(conn: &Connection) -> rusqlite::Result<TemplateList> {
    let mut query = conn.prepare(
        "SELECT id, name, description, version FROM user_template ORDER BY name COLLATE NOCASE, id",
    )?;
    let templates = query
        .query_map([], info)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(TemplateList {
        revision: revision(conn)?,
        templates,
    })
}
pub(crate) fn get(conn: &Connection, id: &str) -> Result<Template, TemplateError> {
    conn.query_row(
        "SELECT id, name, description, version, content FROM user_template WHERE id = ?1",
        [id],
        |row| {
            Ok(Template {
                info: info(row)?,
                content: row.get(4)?,
            })
        },
    )
    .optional()?
    .ok_or(TemplateError::Missing)
}
pub(crate) fn validate(input: &TemplateInput) -> Result<(), TemplateError> {
    if input.id.is_empty()
        || input.id.len() > 128
        || !input
            .id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err(TemplateError::Invalid);
    }
    validate_fields(&input.name, &input.description, &input.content)
}
pub(crate) fn validate_fields(
    name: &str,
    description: &str,
    content: &str,
) -> Result<(), TemplateError> {
    let name = name.trim();
    let description = description.trim();
    if name.is_empty()
        || name.chars().count() > 100
        || name.chars().any(char::is_control)
        || description.chars().count() > 300
        || description.chars().any(char::is_control)
    {
        return Err(TemplateError::Invalid);
    }
    if content.len() > MAX_CONTENT {
        return Err(TemplateError::TooLarge);
    }
    Ok(())
}
fn put(conn: &mut Connection, input: TemplateInput) -> Result<Template, TemplateError> {
    validate(&input)?;
    let tx = conn.transaction()?;
    let result = put_in_transaction(&tx, input)?;
    tx.commit()?;
    Ok(result)
}
pub(crate) fn put_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    input: TemplateInput,
) -> Result<Template, TemplateError> {
    validate(&input)?;
    let name = input.name.trim();
    let description = input.description.trim();
    let current = match get(tx, &input.id) {
        Ok(value) => Some(value),
        Err(TemplateError::Missing) => None,
        Err(error) => return Err(error),
    };
    if let Some(current) = current.as_ref() {
        // A retry after a lost response must not duplicate a saved template.
        if current.info.name == name
            && current.info.description == description
            && current.content == input.content
        {
            return get(tx, &input.id);
        }
        if input.expected_version != Some(current.info.version) {
            return Err(TemplateError::Changed);
        }
    } else {
        if input.expected_version.is_some() {
            return Err(TemplateError::Changed);
        }
        let deleted: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM deleted_user_template WHERE id = ?1)",
            [&input.id],
            |row| row.get(0),
        )?;
        if deleted {
            return Err(TemplateError::Changed);
        }
        let count: i64 =
            tx.query_row("SELECT COUNT(*) FROM user_template", [], |row| row.get(0))?;
        if count >= MAX_TEMPLATES {
            return Err(TemplateError::Limit);
        }
    }
    tx.execute(
        "UPDATE user_templates_state SET revision = revision + 1 WHERE id = 1",
        [],
    )?;
    let version = revision(tx)?;
    tx.execute("INSERT INTO user_template(id, name, description, content, version) VALUES(?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, content = excluded.content, version = excluded.version",
        rusqlite::params![input.id, name, description, input.content, version])?;
    get(tx, &input.id)
}
fn remove(conn: &mut Connection, id: &str, expected_version: i64) -> Result<(), TemplateError> {
    let tx = conn.transaction()?;
    match get(&tx, id) {
        Err(TemplateError::Missing) => return Ok(()),
        Err(error) => return Err(error),
        Ok(current) if current.info.version != expected_version => {
            return Err(TemplateError::Changed)
        }
        Ok(_) => {}
    }
    tx.execute("DELETE FROM user_template WHERE id = ?1", [id])?;
    tx.execute(
        "INSERT OR IGNORE INTO deleted_user_template(id) VALUES(?1)",
        [id],
    )?;
    tx.execute(
        "UPDATE user_templates_state SET revision = revision + 1 WHERE id = 1",
        [],
    )?;
    tx.commit()?;
    Ok(())
}
pub(crate) fn db(
    app: &AppHandle,
) -> Result<std::sync::Arc<crate::style_db::StyleDb>, TemplateError> {
    app.state::<crate::state::AppState>()
        .style_db
        .clone()
        .ok_or_else(|| TemplateError::Io("Template storage unavailable".into()))
}
pub(crate) fn notify(app: &AppHandle, value: i64) {
    if let Err(error) = app.emit("user-templates-changed", value) {
        tracing::warn!("Template notification failed: {error}");
    }
}
#[tauri::command]
pub async fn list_user_templates(app: AppHandle) -> Result<TemplateList, TemplateError> {
    let db = db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db
            .conn
            .lock()
            .map_err(|e| TemplateError::Io(e.to_string()))?;
        Ok(list(&conn)?)
    })
    .await
    .map_err(|e| TemplateError::Io(e.to_string()))?
}
#[tauri::command]
pub async fn get_user_template(app: AppHandle, id: String) -> Result<Template, TemplateError> {
    let db = db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db
            .conn
            .lock()
            .map_err(|e| TemplateError::Io(e.to_string()))?;
        get(&conn, &id)
    })
    .await
    .map_err(|e| TemplateError::Io(e.to_string()))?
}
#[tauri::command]
pub async fn put_user_template(
    app: AppHandle,
    input: TemplateInput,
) -> Result<Template, TemplateError> {
    let db = db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (result, version) = {
            let mut conn = db
                .conn
                .lock()
                .map_err(|e| TemplateError::Io(e.to_string()))?;
            let result = put(&mut conn, input)?;
            let version = result.info.version;
            (result, version)
        };
        notify(&app, version);
        Ok(result)
    })
    .await
    .map_err(|e| TemplateError::Io(e.to_string()))?
}
#[tauri::command]
pub async fn delete_user_template(
    app: AppHandle,
    id: String,
    expected_version: i64,
) -> Result<(), TemplateError> {
    let db = db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let version = {
            let mut conn = db
                .conn
                .lock()
                .map_err(|e| TemplateError::Io(e.to_string()))?;
            remove(&mut conn, &id, expected_version)?;
            // A failed notification read must not turn a committed delete into a failure.
            revision(&conn).ok()
        };
        if let Some(version) = version {
            notify(&app, version);
        }
        Ok(())
    })
    .await
    .map_err(|e| TemplateError::Io(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        create_schema(&conn).unwrap();
        conn
    }
    fn input(id: &str, content: &str, expected_version: Option<i64>) -> TemplateInput {
        TemplateInput {
            id: id.into(),
            name: "회의 형식".into(),
            description: "안건과 후속 작업".into(),
            content: content.into(),
            expected_version,
        }
    }
    #[test]
    fn preserves_exact_markdown_and_retries_without_duplicates() {
        let mut conn = database();
        let text = "---\r\ndate: {{date}}\r\n---\r\n# 회의\r\n![도표](../images/a.png)\r\n";
        let saved = put(&mut conn, input("one", text, None)).unwrap();
        let retry = put(&mut conn, input("one", text, None)).unwrap();
        assert_eq!(saved.info.version, retry.info.version);
        assert_eq!(get(&conn, "one").unwrap().content, text);
        let result = list(&conn).unwrap();
        assert_eq!(result.templates.len(), 1);
        assert!(!serde_json::to_string(&result).unwrap().contains("content"));
        create_schema(&conn).unwrap();
        assert_eq!(list(&conn).unwrap().revision, saved.info.version);
    }
    #[test]
    fn stale_edits_and_deletes_cannot_overwrite_another_window() {
        let mut conn = database();
        let first = put(&mut conn, input("one", "original", None)).unwrap();
        put(&mut conn, input("other", "unrelated", None)).unwrap();
        let next = put(&mut conn, input("one", "new", Some(first.info.version))).unwrap();
        assert!(matches!(
            put(&mut conn, input("one", "stale", Some(first.info.version))),
            Err(TemplateError::Changed)
        ));
        assert!(matches!(
            remove(&mut conn, "one", first.info.version),
            Err(TemplateError::Changed)
        ));
        assert_eq!(get(&conn, "one").unwrap().content, "new");
        remove(&mut conn, "one", next.info.version).unwrap();
        remove(&mut conn, "one", next.info.version).unwrap();
        // A delayed create retry cannot bring a deleted template back.
        assert!(matches!(
            put(&mut conn, input("one", "original", None)),
            Err(TemplateError::Changed)
        ));
        assert_eq!(list(&conn).unwrap().templates.len(), 1);
    }
    #[test]
    fn failed_transactions_preserve_content_revision_and_delete_identity() {
        let mut conn = database();
        let original = put(&mut conn, input("one", "keep", None)).unwrap();
        conn.execute_batch("CREATE TRIGGER fail_revision BEFORE UPDATE ON user_templates_state BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
        assert!(put(&mut conn, input("one", "lost", Some(original.info.version))).is_err());
        assert!(remove(&mut conn, "one", original.info.version).is_err());
        assert_eq!(get(&conn, "one").unwrap().content, "keep");
        assert_eq!(revision(&conn).unwrap(), original.info.version);
        let deleted: i64 = conn
            .query_row("SELECT COUNT(*) FROM deleted_user_template", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(deleted, 0);
        conn.execute_batch("DROP TRIGGER fail_revision;").unwrap();
        put(
            &mut conn,
            input("one", "retry", Some(original.info.version)),
        )
        .unwrap();
    }
    #[test]
    fn validates_size_names_and_capacity_without_mutations() {
        let mut conn = database();
        assert!(matches!(
            put(&mut conn, input("../invalid", "", None)),
            Err(TemplateError::Invalid)
        ));
        assert!(matches!(
            put(
                &mut conn,
                input("large", &"가".repeat(MAX_CONTENT / 3 + 1), None)
            ),
            Err(TemplateError::TooLarge)
        ));
        let mut invalid = input("invalid", "", None);
        invalid.name = " ".into();
        assert!(matches!(
            put(&mut conn, invalid),
            Err(TemplateError::Invalid)
        ));
        assert_eq!(revision(&conn).unwrap(), 0);
        for i in 0..MAX_TEMPLATES {
            put(&mut conn, input(&format!("id-{i}"), "", None)).unwrap();
        }
        assert!(matches!(
            put(&mut conn, input("overflow", "", None)),
            Err(TemplateError::Limit)
        ));
        let existing = get(&conn, "id-0").unwrap();
        put(
            &mut conn,
            input("id-0", "updated at capacity", Some(existing.info.version)),
        )
        .unwrap();
    }
    #[test]
    fn templates_and_versions_survive_reopening() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "iyagi-user-templates-{}-{suffix}.db",
            std::process::id()
        ));
        let saved = {
            let mut conn = Connection::open(&path).unwrap();
            create_schema(&conn).unwrap();
            put(&mut conn, input("persisted", "# 내용", None)).unwrap()
        };
        {
            let conn = Connection::open(&path).unwrap();
            create_schema(&conn).unwrap();
            assert_eq!(get(&conn, "persisted").unwrap().content, "# 내용");
            assert_eq!(list(&conn).unwrap().revision, saved.info.version);
        }
        std::fs::remove_file(path).unwrap();
    }
}
