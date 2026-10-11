//! 폴더 사이드바용 트리 스캔. `.md`/`.markdown`만 걸러 내고 숨김 항목·무거운
//! 디렉터리는 건너뛴다. 파일시스템 감시는 src-tauri의 watcher가 맡고,
//! 여기서는 "지금 이 경로의 트리 모양"만 만든다.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// 무시할 디렉터리 이름(숨김 `.`/`__` 접두사는 별도 규칙으로 처리).
const IGNORED_DIRS: &[&str] = &["node_modules", "target", ".git", "dist", "build", "out", "vendor"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TreeNode {
    Dir {
        name: String,
        path: String,
        children: Vec<TreeNode>,
    },
    File {
        name: String,
        /// 확장자를 제외한 이름 — 사이드바 표시용.
        stem: String,
        path: String,
    },
}

impl TreeNode {
    pub fn name(&self) -> &str {
        match self {
            TreeNode::Dir { name, .. } => name,
            TreeNode::File { name, .. } => name,
        }
    }

    pub fn path(&self) -> &str {
        match self {
            TreeNode::Dir { path, .. } => path,
            TreeNode::File { path, .. } => path,
        }
    }
}

pub fn is_markdown_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// `root` 아래의 마크다운 트리를 만든다. 심볼릭 링크 디렉터리는 따라가지
/// 않는다(순환 방지 — metadata가 아닌 symlink_metadata로 판별).
/// 깊이 제한(기본 12)도 같은 이유다.
pub fn scan_tree(root: &Path) -> std::io::Result<Vec<TreeNode>> {
    scan_dir(root, root, 0, 12)
}

fn scan_dir(root: &Path, dir: &Path, depth: u32, max_depth: u32) -> std::io::Result<Vec<TreeNode>> {
    let mut out: Vec<TreeNode> = Vec::new();
    if depth > max_depth {
        return Ok(out);
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.starts_with("__") || IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            let children = scan_dir(root, &entry.path(), depth + 1, max_depth)?;
            // 빈 폴더(마크다운 없음)는 보여 봤자 클릭할 게 없다 — 접는다.
            if !children.is_empty() {
                out.push(TreeNode::Dir {
                    name,
                    path: entry.path().to_string_lossy().into_owned(),
                    children,
                });
            }
        } else if ft.is_file() && is_markdown_name(&name) {
            // is_markdown_name을 통과했으므로 확장자는 확실히 있다 — 마지막 점 앞까지.
            let stem = match name.rfind('.') {
                Some(i) => name[..i].to_string(),
                None => name.clone(),
            };
            out.push(TreeNode::File {
                name,
                stem,
                path: entry.path().to_string_lossy().into_owned(),
            });
        }
        // 심볼릭 링크는 file_type이 symlink라 위 분기에 걸리지 않는다 — 건너뛴다.
    }
    // 폴더 먼저, 그다음 파일. 대소문자무시 정렬(한글은 코드포인트 순 — 자연스러움).
    out.sort_by(|a, b| {
        let dir_a = matches!(a, TreeNode::Dir { .. });
        let dir_b = matches!(b, TreeNode::Dir { .. });
        dir_b
            .cmp(&dir_a)
            .then_with(|| a.name().to_lowercase().cmp(&b.name().to_lowercase()))
            .then_with(|| a.name().cmp(b.name()))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("md-core-tree-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn scans_only_markdown_sorting_dirs_first() {
        let d = tempdir("basic");
        fs::write(d.join("b.md"), "x").unwrap();
        fs::write(d.join("a.MARKDOWN"), "x").unwrap();
        fs::write(d.join("notes.txt"), "x").unwrap();
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("sub/inner.md"), "x").unwrap();
        let tree = scan_tree(&d).unwrap();
        let names: Vec<&str> = tree.iter().map(|n| n.name()).collect();
        assert_eq!(names, vec!["sub", "a.MARKDOWN", "b.md"]);
        match &tree[0] {
            TreeNode::Dir { children, .. } => assert_eq!(children.len(), 1),
            _ => panic!("첫 항목은 디렉터리여야 한다"),
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn skips_hidden_and_ignored_and_empty() {
        let d = tempdir("hidden");
        fs::create_dir_all(d.join(".git")).unwrap();
        fs::write(d.join(".git/config.md"), "x").unwrap();
        fs::create_dir_all(d.join("node_modules/pkg")).unwrap();
        fs::write(d.join("node_modules/pkg/readme.md"), "x").unwrap();
        fs::create_dir_all(d.join("empty-dir")).unwrap();
        fs::write(d.join(".hidden.md"), "x").unwrap();
        fs::write(d.join("ok.md"), "x").unwrap();
        let tree = scan_tree(&d).unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].name(), "ok.md");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn markdown_name_detection() {
        assert!(is_markdown_name("a.md"));
        assert!(is_markdown_name("B.Md"));
        assert!(is_markdown_name("c.markdown"));
        assert!(!is_markdown_name("d.mdx"));
        assert!(!is_markdown_name("md"));
    }

    #[test]
    fn stem_extraction() {
        let d = tempdir("stem");
        fs::write(d.join("My Note.md"), "x").unwrap();
        fs::write(d.join("deep.MARKDOWN"), "x").unwrap();
        let tree = scan_tree(&d).unwrap();
        let stems: Vec<String> = tree
            .iter()
            .filter_map(|n| match n {
                TreeNode::File { stem, .. } => Some(stem.clone()),
                _ => None,
            })
            .collect();
        assert!(stems.contains(&"My Note".to_string()));
        assert!(stems.contains(&"deep".to_string()));
        let _ = fs::remove_dir_all(&d);
    }
}
