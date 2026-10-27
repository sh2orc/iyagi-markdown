//! Portable, versioned template archives. Import never overwrites existing rows.
use crate::user_templates::{self as templates, TemplateError, TemplateInput};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    io::{BufRead, Read, Write},
    path::Path,
};
use tauri::AppHandle;

const FORMAT: &str = "iyagi-markdown-templates";
const MAX_ARCHIVE: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableTemplate {
    name: String,
    description: String,
    content: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateArchive {
    format: String,
    version: u32,
    templates: Vec<PortableTemplate>,
}

fn validate_archive(archive: &TemplateArchive) -> Result<(), TemplateError> {
    if archive.format != FORMAT
        || archive.version != 1
        || archive.templates.is_empty()
        || archive.templates.len() > templates::MAX_TEMPLATES as usize
    {
        return Err(TemplateError::ArchiveInvalid);
    }
    for item in &archive.templates {
        templates::validate_fields(&item.name, &item.description, &item.content)?;
    }
    Ok(())
}
fn read_archive(path: &Path) -> Result<TemplateArchive, TemplateError> {
    if !path.is_absolute() {
        return Err(TemplateError::ArchiveInvalid);
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|e| TemplateError::Io(e.to_string()))?;
    let metadata = file
        .metadata()
        .map_err(|e| TemplateError::Io(e.to_string()))?;
    if !metadata.is_file() {
        return Err(TemplateError::ArchiveInvalid);
    }
    if metadata.len() > MAX_ARCHIVE as u64 {
        return Err(TemplateError::ArchiveTooLarge);
    }
    // Parse incrementally instead of keeping both the complete JSON and its decoded bodies.
    let mut reader = std::io::BufReader::new(file);
    let bom = reader
        .fill_buf()
        .map_err(|e| TemplateError::Io(e.to_string()))?
        .starts_with(&[0xef, 0xbb, 0xbf]);
    if bom {
        reader.consume(3);
    }
    let mut bounded = reader.take(MAX_ARCHIVE as u64 + 1 - if bom { 3 } else { 0 });
    let decoded = serde_json::from_reader::<_, TemplateArchive>(&mut bounded);
    if bounded.limit() == 0 {
        return Err(TemplateError::ArchiveTooLarge);
    }
    let archive = decoded.map_err(|error| {
        if error.is_io() {
            TemplateError::Io(error.to_string())
        } else {
            TemplateError::ArchiveInvalid
        }
    })?;
    validate_archive(&archive)?;
    Ok(archive)
}
fn collect(
    conn: &rusqlite::Connection,
    ids: &[String],
    expected_revision: i64,
) -> Result<TemplateArchive, TemplateError> {
    if ids.is_empty()
        || ids.len() > templates::MAX_TEMPLATES as usize
        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
    {
        return Err(TemplateError::ArchiveInvalid);
    }
    if templates::revision(conn)? != expected_revision {
        return Err(TemplateError::Changed);
    }
    let entries = ids
        .iter()
        .map(|id| {
            templates::get(conn, id).map(|record| PortableTemplate {
                name: record.info.name,
                description: record.info.description,
                content: record.content,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(TemplateArchive {
        format: FORMAT.into(),
        version: 1,
        templates: entries,
    })
}

struct LimitedWriter<'a, W> {
    writer: W,
    remaining: usize,
    exceeded: &'a mut bool,
}
impl<W: Write> Write for LimitedWriter<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.remaining {
            *self.exceeded = true;
            return Err(std::io::Error::other("Template archive exceeds 64 MiB"));
        }
        let written = self.writer.write(bytes)?;
        self.remaining -= written;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.writer.flush()
    }
}
fn write_archive(path: &Path, archive: &TemplateArchive) -> Result<(), TemplateError> {
    write_archive_with_limit(path, archive, MAX_ARCHIVE)
}
fn write_archive_with_limit(
    path: &Path,
    archive: &TemplateArchive,
    limit: usize,
) -> Result<(), TemplateError> {
    if !path.is_absolute()
        || !path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(TemplateError::ArchiveInvalid);
    }
    let mut exceeded = false;
    let result = md_core::io::write_file_atomic(path, |file| {
        let mut writer = LimitedWriter {
            writer: std::io::BufWriter::new(file),
            remaining: limit,
            exceeded: &mut exceeded,
        };
        serde_json::to_writer_pretty(&mut writer, archive).map_err(std::io::Error::other)?;
        writer.flush()
    });
    if exceeded {
        return Err(TemplateError::ArchiveTooLarge);
    }
    result.map_err(|e| TemplateError::Io(e.to_string()))
}
fn import(
    conn: &mut rusqlite::Connection,
    entries: Vec<TemplateInput>,
) -> Result<i64, TemplateError> {
    if entries.is_empty()
        || entries.len() > templates::MAX_TEMPLATES as usize
        || entries
            .iter()
            .map(|item| &item.id)
            .collect::<HashSet<_>>()
            .len()
            != entries.len()
        || entries.iter().any(|item| item.expected_version.is_some())
    {
        return Err(TemplateError::ArchiveInvalid);
    }
    for entry in &entries {
        templates::validate(entry)?;
    }
    let tx = conn.transaction()?;
    for entry in entries {
        templates::put_in_transaction(&tx, entry)?;
    }
    let version = templates::revision(&tx)?;
    tx.commit()?;
    Ok(version)
}

#[tauri::command]
pub async fn read_template_archive(path: String) -> Result<TemplateArchive, TemplateError> {
    tauri::async_runtime::spawn_blocking(move || read_archive(Path::new(&path)))
        .await
        .map_err(|e| TemplateError::Io(e.to_string()))?
}
#[tauri::command]
pub async fn export_template_archive(
    app: AppHandle,
    out_path: String,
    ids: Vec<String>,
    expected_revision: i64,
) -> Result<(), TemplateError> {
    let db = templates::db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Freeze the selected records under the DB lock, then release it before file IO.
        let archive = {
            let conn = db
                .conn
                .lock()
                .map_err(|e| TemplateError::Io(e.to_string()))?;
            collect(&conn, &ids, expected_revision)?
        };
        write_archive(Path::new(&out_path), &archive)
    })
    .await
    .map_err(|e| TemplateError::Io(e.to_string()))?
}
#[tauri::command]
pub async fn import_template_archive(
    app: AppHandle,
    entries: Vec<TemplateInput>,
) -> Result<i64, TemplateError> {
    let db = templates::db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let version = {
            let mut conn = db
                .conn
                .lock()
                .map_err(|e| TemplateError::Io(e.to_string()))?;
            import(&mut conn, entries)?
        };
        templates::notify(&app, version);
        Ok(version)
    })
    .await
    .map_err(|e| TemplateError::Io(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        templates::create_schema(&conn).unwrap();
        conn
    }
    fn entry(id: &str, content: &str) -> TemplateInput {
        TemplateInput {
            id: id.into(),
            name: "회의".into(),
            description: "안건".into(),
            content: content.into(),
            expected_version: None,
        }
    }
    fn folder() -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "iyagi-template-archive-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn round_trip_keeps_text_but_does_not_export_local_ids_or_versions() {
        let mut conn = db();
        let source = "---\r\ndate: {{date}}\r\n---\r\n# 회의\r\n![image](../a.png)\r\n";
        let version = import(
            &mut conn,
            vec![entry("local-one", source), entry("local-two", "second")],
        )
        .unwrap();
        let archive = collect(&conn, &["local-one".into()], version).unwrap();
        let dir = folder();
        let path = dir.join("templates.json");
        write_archive(&path, &archive).unwrap();
        let json = std::fs::read_to_string(&path).unwrap();
        assert!(!json.contains("local-one"));
        assert!(!json.contains("expectedVersion"));
        let loaded = read_archive(&path).unwrap();
        assert_eq!(loaded.templates.len(), 1);
        assert_eq!(loaded.templates[0].content, source);
        let mut destination = db();
        import(
            &mut destination,
            vec![entry("new-copy", &loaded.templates[0].content)],
        )
        .unwrap();
        assert_eq!(
            templates::get(&destination, "new-copy").unwrap().content,
            source
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn batch_retry_is_idempotent_and_conflicts_roll_back_earlier_inserts() {
        let mut conn = db();
        let version = import(&mut conn, vec![entry("one", "A"), entry("two", "B")]).unwrap();
        assert_eq!(
            import(&mut conn, vec![entry("one", "A"), entry("two", "B")]).unwrap(),
            version
        );
        assert!(matches!(
            import(
                &mut conn,
                vec![entry("new", "new"), entry("one", "overwrite")]
            ),
            Err(TemplateError::Changed)
        ));
        assert!(matches!(
            templates::get(&conn, "new"),
            Err(TemplateError::Missing)
        ));
        assert_eq!(templates::get(&conn, "one").unwrap().content, "A");
        assert_eq!(templates::revision(&conn).unwrap(), version);
        let mut update = entry("one", "overwrite");
        update.expected_version = Some(1);
        assert!(matches!(
            import(&mut conn, vec![update]),
            Err(TemplateError::ArchiveInvalid)
        ));
        assert!(matches!(
            import(&mut conn, vec![entry("same", "A"), entry("same", "A")]),
            Err(TemplateError::ArchiveInvalid)
        ));
    }
    #[test]
    fn capacity_and_database_failures_leave_no_partial_import() {
        let mut conn = db();
        let rows = (0..99).map(|i| entry(&format!("old-{i}"), "")).collect();
        let version = import(&mut conn, rows).unwrap();
        assert!(matches!(
            import(&mut conn, vec![entry("first", "1"), entry("second", "2")]),
            Err(TemplateError::Limit)
        ));
        assert_eq!(templates::revision(&conn).unwrap(), version);
        assert!(matches!(
            templates::get(&conn, "first"),
            Err(TemplateError::Missing)
        ));
        let mut conn = db();
        conn.execute_batch("CREATE TRIGGER fail_second BEFORE INSERT ON user_template WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'disk failure'); END;").unwrap();
        assert!(import(&mut conn, vec![entry("first", "1"), entry("second", "2")]).is_err());
        assert_eq!(templates::revision(&conn).unwrap(), 0);
        assert!(matches!(
            templates::get(&conn, "first"),
            Err(TemplateError::Missing)
        ));
    }
    #[test]
    fn rejects_invalid_archives_and_accepts_utf8_bom() {
        let dir = folder();
        let path = dir.join("templates.json");
        for invalid in [
            r#"{"format":"other","version":1,"templates":[]}"#,
            r#"{"format":"iyagi-markdown-templates","version":2,"templates":[]}"#,
            r#"{"format":"iyagi-markdown-templates","version":1,"templates":[{"name":"A","description":"","content":"text","id":"injected"}]}"#,
            "not json",
        ] {
            std::fs::write(&path, invalid).unwrap();
            assert!(read_archive(&path).is_err());
        }
        let mut conn = db();
        let version = import(&mut conn, vec![entry("one", "text")]).unwrap();
        let archive = collect(&conn, &["one".into()], version).unwrap();
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend(serde_json::to_vec(&archive).unwrap());
        std::fs::write(&path, bytes).unwrap();
        assert_eq!(read_archive(&path).unwrap().templates[0].content, "text");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_ARCHIVE as u64 + 1).unwrap();
        assert!(matches!(
            read_archive(&path),
            Err(TemplateError::ArchiveTooLarge)
        ));
        drop(file);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn export_requires_reviewed_revision_and_failure_preserves_previous_file() {
        let mut conn = db();
        let version = import(&mut conn, vec![entry("one", "text")]).unwrap();
        let archive = collect(&conn, &["one".into()], version).unwrap();
        import(&mut conn, vec![entry("two", "new")]).unwrap();
        assert!(matches!(
            collect(&conn, &["one".into()], version),
            Err(TemplateError::Changed)
        ));
        let dir = folder();
        let path = dir.join("backup.json");
        std::fs::write(&path, "previous backup").unwrap();
        assert!(matches!(
            write_archive_with_limit(&path, &archive, 20),
            Err(TemplateError::ArchiveTooLarge)
        ));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "previous backup");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
