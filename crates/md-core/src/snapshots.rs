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
        if same_content || now.saturating_sub(last.ts) < MIN_INTERVAL_MS {
            return Ok(());
        }
    }
    fs::write(dir.join(format!("{now}.md")), text)?;
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

/// 현재 시각으로 저장.
pub fn save_snapshot(app_data: &Path, doc_path: &str, text: &str) -> io::Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    save_snapshot_at(app_data, doc_path, text, now)
}

/// 스냅숏 목록(오래된 순).
pub fn list_snapshots(app_data: &Path, doc_path: &str) -> Vec<SnapshotInfo> {
    list_snapshots_at(&doc_dir(app_data, doc_path)).unwrap_or_default()
}

fn list_snapshots_at(dir: &Path) -> io::Result<Vec<SnapshotInfo>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(ts) = name.strip_suffix(".md").and_then(|s| s.parse::<u64>().ok()) else {
            continue;
        };
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(SnapshotInfo { ts, size });
    }
    out.sort_by_key(|s| s.ts);
    Ok(out)
}

/// 스냅숏 내용 읽기(시각 = 파일명).
pub fn read_snapshot(app_data: &Path, doc_path: &str, ts: u64) -> io::Result<String> {
    fs::read_to_string(doc_dir(app_data, doc_path).join(format!("{ts}.md")))
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
    fn roundtrip_and_ordering() {
        let d = tempdir("rt");
        save_snapshot_at(&d, "/w/a.md", "v0", 1_000).unwrap();
        save_snapshot_at(&d, "/w/a.md", "v1", 200_000).unwrap();
        let list = list_snapshots(&d, "/w/a.md");
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
        assert_eq!(list_snapshots(&d, "/w/b.md").len(), 1);
        assert_eq!(read_snapshot(&d, "/w/b.md", 1_000).unwrap(), "same");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn prune_keeps_latest_max() {
        let d = tempdir("prune");
        for i in 0..(MAX_PER_DOC + 5) as u64 {
            save_snapshot_at(&d, "/w/c.md", &format!("v{i}"), 1_000 + i * 120_000).unwrap();
        }
        let list = list_snapshots(&d, "/w/c.md");
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
        assert_eq!(list_snapshots(&d, "/w/x.md").len(), 1);
        assert_eq!(read_snapshot(&d, "/w/x.md", 1_000).unwrap(), "one");
        assert_eq!(read_snapshot(&d, "/w/y.md", 1_000).unwrap(), "two");
        let _ = fs::remove_dir_all(&d);
    }
}
