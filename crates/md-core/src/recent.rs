//! 최근 문서 목록 — 같은 파일은 최상단으로, 20개 넘으면 오래된 항목부터 버린다.

use std::path::Path;

use serde::{Deserialize, Serialize};

pub const RECENT_CAP: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    /// 목록 표시용 파일 이름(캐시 — 없으면 경로에서 다시 뽑는다).
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentList {
    entries: Vec<RecentEntry>,
}

impl RecentList {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn entries(&self) -> &[RecentEntry] {
        &self.entries
    }

    /// `path`를 최상단에 올린다(중복 제거, cap 초과분 절삭). 변경이 있었으면 true.
    pub fn push(&mut self, path: &str) -> bool {
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
        let before = self.entries.clone();
        self.entries.retain(|e| e.path != path);
        self.entries.insert(
            0,
            RecentEntry {
                path: path.to_string(),
                name,
            },
        );
        self.entries.truncate(RECENT_CAP);
        before != self.entries
    }

    pub fn remove(&mut self, path: &str) {
        self.entries.retain(|e| e.path != path);
    }

    /// 디스크에 더 이상 없는 항목을 제거한 뒤 변경 여부를 돌려준다.
    pub fn prune_missing(&mut self) -> bool {
        let before_len = self.entries.len();
        self.entries.retain(|e| Path::new(&e.path).is_file());
        before_len != self.entries.len()
    }

    pub fn load(path: &Path) -> RecentList {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => RecentList::default(),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(path, serde_json::to_vec_pretty(self).unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("md-core-recent-{tag}-{}.json", std::process::id()))
    }

    #[test]
    fn push_moves_to_front_and_dedupes() {
        let mut r = RecentList::new();
        r.push("/a.md");
        r.push("/b.md");
        r.push("/a.md");
        let paths: Vec<&str> = r.entries().iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["/a.md", "/b.md"]);
        assert_eq!(r.entries()[0].name, "a.md");
    }

    #[test]
    fn cap_is_enforced() {
        let mut r = RecentList::new();
        for i in 0..(RECENT_CAP + 5) {
            r.push(&format!("/f{i}.md"));
        }
        assert_eq!(r.entries().len(), RECENT_CAP);
        assert_eq!(r.entries()[0].path, format!("/f{}.md", RECENT_CAP + 4));
    }

    #[test]
    fn persistence_roundtrip() {
        let p = rp("rt");
        let _ = std::fs::remove_file(&p);
        let mut r = RecentList::new();
        r.push("/x/y.md");
        r.save(&p).unwrap();
        let r2 = RecentList::load(&p);
        assert_eq!(r, r2);
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn corrupt_file_yields_empty() {
        let p = rp("corrupt");
        std::fs::write(&p, "{not json").unwrap();
        assert_eq!(RecentList::load(&p), RecentList::default());
        let _ = std::fs::remove_file(&p);
    }
}
