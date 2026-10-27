//! 문서 스냅숏(버전 기록) — 저장이 원문을 교체하기 직전의 내용을 앱 데이터
//! 디렉터리에 쌓는다(Obsidian file recovery·Notion 버전 기록과 같은 의미론:
//! 디스크는 항상 최신, 스냅숏은 지나간 모든 저장 직전 상태).
//! .md 원문은 건드리지 않는 사이드카. 파일당 최대 30개, 최소 간격 60초,
//! 같은 내용은 생략해 디스크 낭비를 막는다.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 문서당 보존 스냅숏 수.
pub const MAX_PER_DOC: usize = 30;
/// 같은 문서의 연속 스냅숏 최소 간격(밀리초) — 자동 저장 흐름의 쓰레기 방지.
pub const MIN_INTERVAL_MS: u64 = 60_000;
static SNAPSHOT_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    /// 생성 시각(에포크 밀리초) — 파일명이기도 하다.
    pub ts: u64,
    /// 바이트 크기 — 목록 표시용.
    pub size: u64,
}

#[derive(Serialize, Deserialize)]
struct MetaJson {
    path: String,
}

pub fn snapshots_dir(app_data: &Path) -> PathBuf {
    app_data.join("snapshots")
}

/// 문서 경로 → 스냅숏 디렉터리명: FNV-1a 64 해시 + 정제된 stem(가독성·충돌 완화).
fn doc_dir(app_data: &Path, doc_path: &str) -> PathBuf {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in doc_path.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let stem = doc_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("doc")
        .trim_end_matches(".md")
        .trim_end_matches(".markdown");
    let safe: String = stem
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .take(48)
        .collect();
    snapshots_dir(app_data).join(format!("{h:016x}-{safe}"))
}

/// 스냅숏 저장(교체되는 내용을 넣는다). now는 테스트 주입용.
/// 마지막 스냅숏과 같은 내용이거나 최소 간격 이내면 생략한다.
pub fn save_snapshot_at(app_data: &Path, doc_path: &str, text: &str, now: u64) -> io::Result<()> {
    save_snapshot_inner(app_data, doc_path, text, now, false)
}

/// 일괄 변경·버전 복원은 최소 저장 간격 안에서도 교체 전 버전을 반드시 남긴다.
pub fn save_before_bulk(app_data: &Path, doc_path: &str, text: &str) -> io::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    save_snapshot_inner(app_data, doc_path, text, now, true)
}

fn save_snapshot_inner(
    app_data: &Path,
    doc_path: &str,
    text: &str,
    mut now: u64,
    required: bool,
) -> io::Result<()> {
    let _guard = SNAPSHOT_WRITES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let dir = doc_dir(app_data, doc_path);
    fs::create_dir_all(&dir)?;
    let list = list_snapshots_at(&dir)?;
    if let Some(last) = list.last() {
        let last_file = dir.join(format!("{}.md", last.ts));
        let same_content = fs::metadata(&last_file)
            .map(|m| m.len() as usize == text.len())
            .unwrap_or(false)
            && fs::read_to_string(&last_file)
                .map(|s| s == text)
                .unwrap_or(false);
        if same_content || (!required && now.saturating_sub(last.ts) < MIN_INTERVAL_MS) {
            return Ok(());
        }
        now = now.max(last.ts.saturating_add(1));
    }
    // 원자적 기록(문서 저장과 같은 규약) — 도중 크래시로 잘린 스냅숏이
    // 버전 목록에 올라와 복원되는 일이 없게 한다.
    crate::io::write_bytes_atomic(&dir.join(format!("{now}.md")), text.as_bytes())
        .map_err(|e| io::Error::other(e.to_string()))?;
    // 원본 경로 기록(복원 목록 필터·정리용) — 실패해도 스냅숏 자체는 유효.
    let _ = fs::write(
        dir.join("meta.json"),
        serde_json::to_vec(&MetaJson {
            path: doc_path.to_string(),
        })
        .unwrap_or_default(),
    );
    prune(&dir)?;
    Ok(())
}

/// 이름 변경 뒤에도 버전 기록을 제공한다. 원래 기록은 복구용으로 남기며,
/// 새 경로의 동시각 스냅숏을 덮어쓰지 않는다.
pub fn copy_history(app_data: &Path, from: &str, to: &str) -> io::Result<()> {
    let source = doc_dir(app_data, from);
    if !source.exists() {
        return Ok(());
    }
    let target = doc_dir(app_data, to);
    fs::create_dir_all(&target)?;
    for snapshot in list_snapshots_at(&source)? {
        let name = format!("{}.md", snapshot.ts);
        // 같은 앱 데이터 볼륨의 불변 스냅숏: 하드 링크는 원자적이며
        // 대상이 있으면 실패한다. 정리 시 원래 기록의 데이터도 유지된다.
        match fs::hard_link(source.join(&name), target.join(&name)) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if fs::read(source.join(&name))? != fs::read(target.join(&name))? {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        "Snapshot history conflict",
                    ));
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// 현재 시각으로 저장.
pub fn save_snapshot(app_data: &Path, doc_path: &str, text: &str) -> io::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    save_snapshot_at(app_data, doc_path, text, now)
}

/// 스냅숏 목록(오래된 순).
pub fn list_snapshots(app_data: &Path, doc_path: &str) -> io::Result<Vec<SnapshotInfo>> {
    list_snapshots_at(&doc_dir(app_data, doc_path))
}

fn list_snapshots_at(dir: &Path) -> io::Result<Vec<SnapshotInfo>> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(ts) = name.strip_suffix(".md").and_then(|s| s.parse::<u64>().ok()) else {
            continue;
        };
        if !entry.file_type()?.is_file() {
            continue;
        }
        let size = entry.metadata()?.len();
        out.push(SnapshotInfo { ts, size });
    }
    out.sort_by_key(|s| s.ts);
    Ok(out)
}

/// 스냅숏 내용 읽기(시각 = 파일명).
pub fn read_snapshot(app_data: &Path, doc_path: &str, ts: u64) -> io::Result<String> {
    // 일반 저장 기록은 BOM/CRLF가 포함될 수 있다. 편집 버퍼와 같은 규약으로 읽는다.
    crate::io::read_doc(&doc_dir(app_data, doc_path).join(format!("{ts}.md")))
        .map(|doc| doc.text)
        .map_err(|e| io::Error::other(e.to_string()))
}

/// 오래된 것부터 MAX_PER_DOC개만 남긴다.
fn prune(dir: &Path) -> io::Result<()> {
    let list = list_snapshots_at(dir)?;
    if list.len() <= MAX_PER_DOC {
        return Ok(());
    }
    for s in &list[..list.len() - MAX_PER_DOC] {
        let _ = fs::remove_file(dir.join(format!("{}.md", s.ts)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("md-core-snap-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rename_history_keeps_original_and_new_path_readable() {
        let dir = tempdir("rename");
        save_snapshot_at(&dir, "/notes/old.md", "original", 1000).unwrap();
        copy_history(&dir, "/notes/old.md", "/notes/new.md").unwrap();
        assert_eq!(
            read_snapshot(&dir, "/notes/new.md", 1000).unwrap(),
            "original"
        );
        assert_eq!(
            read_snapshot(&dir, "/notes/old.md", 1000).unwrap(),
            "original"
        );
        copy_history(&dir, "/notes/old.md", "/notes/new.md").unwrap();
        assert_eq!(list_snapshots(&dir, "/notes/new.md").unwrap().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rename_history_never_overwrites_a_different_snapshot() {
        let dir = tempdir("rename-conflict");
        save_snapshot_at(&dir, "/old.md", "old", 1000).unwrap();
        save_snapshot_at(&dir, "/new.md", "existing", 1000).unwrap();
        assert!(copy_history(&dir, "/old.md", "/new.md").is_err());
        assert_eq!(read_snapshot(&dir, "/new.md", 1000).unwrap(), "existing");
        assert_eq!(read_snapshot(&dir, "/old.md", 1000).unwrap(), "old");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn roundtrip_and_ordering() {
        let d = tempdir("rt");
        save_snapshot_at(&d, "/w/a.md", "v0", 1_000).unwrap();
        save_snapshot_at(&d, "/w/a.md", "v1", 200_000).unwrap();
        let list = list_snapshots(&d, "/w/a.md").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].ts, 1_000);
        assert_eq!(list[1].ts, 200_000);
        assert_eq!(list[1].size, 2);
        assert_eq!(read_snapshot(&d, "/w/a.md", 1_000).unwrap(), "v0");
        assert_eq!(read_snapshot(&d, "/w/a.md", 200_000).unwrap(), "v1");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn same_content_and_interval_are_skipped() {
        let d = tempdir("skip");
        save_snapshot_at(&d, "/w/b.md", "same", 1_000).unwrap();
        save_snapshot_at(&d, "/w/b.md", "same", 900_000).unwrap(); // 같은 내용
        save_snapshot_at(&d, "/w/b.md", "diff", 30_000).unwrap(); // 간격 < 60s
        assert_eq!(list_snapshots(&d, "/w/b.md").unwrap().len(), 1);
        assert_eq!(read_snapshot(&d, "/w/b.md", 1_000).unwrap(), "same");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn prune_keeps_latest_max() {
        let d = tempdir("prune");
        for i in 0..(MAX_PER_DOC + 5) as u64 {
            save_snapshot_at(&d, "/w/c.md", &format!("v{i}"), 1_000 + i * 120_000).unwrap();
        }
        let list = list_snapshots(&d, "/w/c.md").unwrap();
        assert_eq!(list.len(), MAX_PER_DOC);
        assert_eq!(list[0].ts, 1_000 + 5 * 120_000); // 오래된 5개 삭제
        assert!(read_snapshot(&d, "/w/c.md", 1_000).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn different_docs_do_not_mix() {
        let d = tempdir("mix");
        save_snapshot_at(&d, "/w/x.md", "one", 1_000).unwrap();
        save_snapshot_at(&d, "/w/y.md", "two", 1_000).unwrap();
        assert_eq!(list_snapshots(&d, "/w/x.md").unwrap().len(), 1);
        assert_eq!(read_snapshot(&d, "/w/x.md", 1_000).unwrap(), "one");
        assert_eq!(read_snapshot(&d, "/w/y.md", 1_000).unwrap(), "two");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn bulk_backup_keeps_a_new_version_inside_the_normal_interval() {
        let dir = tempdir("bulk-required");
        save_snapshot_inner(&dir, "/w/doc.md", "older", 1_000, false).unwrap();
        save_snapshot_inner(&dir, "/w/doc.md", "before bulk", 1_000, true).unwrap();
        let versions = list_snapshots(&dir, "/w/doc.md").unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[1].ts, 1_001);
        assert_eq!(
            read_snapshot(&dir, "/w/doc.md", versions[1].ts).unwrap(),
            "before bulk"
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_history_is_empty_but_broken_history_is_an_error() {
        let dir = tempdir("list-error");
        assert!(list_snapshots(&dir, "/w/doc.md").unwrap().is_empty());
        fs::create_dir_all(snapshots_dir(&dir)).unwrap();
        fs::write(doc_dir(&dir, "/w/doc.md"), "not a directory").unwrap();
        assert!(list_snapshots(&dir, "/w/doc.md").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn snapshot_reads_normalize_bom_and_line_endings_like_documents() {
        let dir = tempdir("normalize");
        save_snapshot_at(&dir, "/w/doc.md", "\u{feff}first\r\nsecond\rthird", 1000).unwrap();
        assert_eq!(
            read_snapshot(&dir, "/w/doc.md", 1000).unwrap(),
            "first\nsecond\nthird"
        );
        fs::create_dir(doc_dir(&dir, "/w/doc.md").join("2000.md")).unwrap();
        assert_eq!(list_snapshots(&dir, "/w/doc.md").unwrap().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
}
