//! 폴더 사이드바용 트리 스캔. `.md`/`.markdown`만 걸러 내고 숨김 항목·무거운
//! 디렉터리는 건너뛴다. 파일시스템 감시는 src-tauri의 watcher가 맡고,
//! 여기서는 "지금 이 경로의 트리 모양"만 만든다.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// 무시할 디렉터리 이름(숨김 `.`/`__` 접두사는 별도 규칙으로 처리).
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    ".git",
    "dist",
    "build",
    "out",
    "vendor",
];

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

/// 디렉터리 건너뛰기 규칙 — 트리 스캔과 전체 검색이 같은 파일 세계를 보게
/// 한다(규칙이 갈라지면 사이드바에 있는 파일이 검색에 없는 일이 생긴다).
pub fn should_skip_dir_name(name: &str) -> bool {
    name.starts_with('.') || name.starts_with("__") || IGNORED_DIRS.contains(&name)
}

/// 읽지 못한 경로와 제한에 도달한 경로를 UI에 함께 전달한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanIssue {
    pub path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceScan {
    pub tree: Vec<TreeNode>,
    pub issues: Vec<ScanIssue>,
}

const MAX_ENTRIES: usize = 20_000;
const MAX_DEPTH: u32 = 12;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum CreateFolderError {
    #[error("Enter a single folder name without separators or control characters.")]
    InvalidName,
    #[error("This folder name is excluded from the workspace listing.")]
    HiddenName,
    #[error("A file or folder with that name already exists.")]
    Exists,
    #[error("Choose a visible folder inside the workspace.")]
    Outside,
    #[error("Open this folder as a workspace before creating deeper folders.")]
    Depth,
    #[error("{0}")]
    Io(String),
}

/// Create one visible directory without replacing an existing entry or creating
/// missing ancestors. The returned path uses the workspace's original spelling.
pub fn create_folder(root: &Path, dir: &Path, name: &str) -> Result<String, CreateFolderError> {
    use std::path::Component;
    use CreateFolderError as Error;
    if name.trim().is_empty()
        || name != name.trim()
        || matches!(name, "." | "..")
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return Err(Error::InvalidName);
    }
    if should_skip_dir_name(name) {
        return Err(Error::HiddenName);
    }
    if !root.is_absolute()
        || !dir.is_absolute()
        || root
            .components()
            .chain(dir.components())
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(Error::Outside);
    }
    let relative = dir.strip_prefix(root).map_err(|_| Error::Outside)?;
    if relative.components().count() > MAX_DEPTH as usize {
        return Err(Error::Depth);
    }
    let mut ancestor = root.to_path_buf();
    for part in relative.components() {
        let Component::Normal(segment) = part else {
            return Err(Error::Outside);
        };
        if segment.to_str().is_none_or(should_skip_dir_name) {
            return Err(Error::Outside);
        }
        ancestor.push(segment);
        let meta =
            std::fs::symlink_metadata(&ancestor).map_err(|error| Error::Io(error.to_string()))?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(Error::Outside);
        }
    }
    let real_root = root
        .canonicalize()
        .map_err(|error| Error::Io(error.to_string()))?;
    let real_dir = dir
        .canonicalize()
        .map_err(|error| Error::Io(error.to_string()))?;
    if !real_dir.starts_with(&real_root) || !real_dir.is_dir() {
        return Err(Error::Outside);
    }
    let path = dir
        .join(name)
        .to_str()
        .ok_or_else(|| Error::Io("Unsupported path encoding".into()))?
        .to_owned();
    // create_dir fails for existing directories, files and dangling symlinks.
    std::fs::create_dir(real_dir.join(name)).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Error::Exists
        } else {
            Error::Io(error.to_string())
        }
    })?;
    Ok(path)
}

struct ScanBudget {
    remaining: usize,
    exhausted: bool,
}

fn issue(issues: &mut Vec<ScanIssue>, path: &Path, code: &str, message: impl ToString) {
    issues.push(ScanIssue {
        path: path.to_string_lossy().into_owned(),
        code: code.into(),
        message: message.to_string(),
    });
}

/// 루트 조회 실패는 오류다. 하위 경로 실패는 형제 경로를 유지하는 부분 결과다.
/// 심볼릭 링크·숨김/무시 항목은 기존 탐색 규칙대로 제외한다.
pub fn scan_tree(root: &Path) -> std::io::Result<WorkspaceScan> {
    scan_with_limits(root, MAX_DEPTH, MAX_ENTRIES)
}

fn scan_with_limits(
    root: &Path,
    max_depth: u32,
    max_entries: usize,
) -> std::io::Result<WorkspaceScan> {
    let entries = std::fs::read_dir(root)?;
    let mut issues = Vec::new();
    let mut budget = ScanBudget {
        remaining: max_entries,
        exhausted: false,
    };
    let tree = scan_dir(root, entries, 0, max_depth, &mut budget, &mut issues);
    Ok(WorkspaceScan { tree, issues })
}

fn scan_dir(
    dir: &Path,
    entries: std::fs::ReadDir,
    depth: u32,
    max_depth: u32,
    budget: &mut ScanBudget,
    issues: &mut Vec<ScanIssue>,
) -> Vec<TreeNode> {
    let mut out = Vec::new();
    for entry in entries {
        if budget.exhausted {
            break;
        }
        if budget.remaining == 0 {
            issue(issues, dir, "limit", "Workspace entry limit reached");
            budget.exhausted = true;
            break;
        }
        budget.remaining -= 1;
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                issue(issues, dir, "read", error);
                continue;
            }
        };
        let path = entry.path();
        let name = match entry.file_name().into_string() {
            Ok(name) => name,
            Err(_) => {
                issue(issues, &path, "encoding", "Unsupported file name encoding");
                continue;
            }
        };
        if should_skip_dir_name(&name) {
            continue;
        }
        // 문자열로 전달할 수 없는 부모 경로도 잘못된 경로로 열지 않는다.
        let Some(path_text) = path.to_str().map(str::to_owned) else {
            issue(issues, &path, "encoding", "Unsupported path encoding");
            continue;
        };
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(error) => {
                issue(issues, &path, "read", error);
                continue;
            }
        };
        if ft.is_dir() {
            let children = if depth >= max_depth {
                issue(issues, &path, "depth", "Folder depth limit reached");
                Vec::new()
            } else {
                match std::fs::read_dir(&path) {
                    Ok(children) => scan_dir(&path, children, depth + 1, max_depth, budget, issues),
                    Err(error) => {
                        issue(issues, &path, "read", error);
                        Vec::new()
                    }
                }
            };
            // 빈 폴더도 새 문서를 만들 위치로 선택할 수 있게 남긴다.
            out.push(TreeNode::Dir {
                name,
                path: path_text,
                children,
            });
        } else if ft.is_file() && is_markdown_name(&name) {
            let stem = name
                .rfind('.')
                .map(|i| name[..i].to_string())
                .unwrap_or_else(|| name.clone());
            out.push(TreeNode::File {
                name,
                stem,
                path: path_text,
            });
        }
    }
    out.sort_by(|a, b| {
        let dir_a = matches!(a, TreeNode::Dir { .. });
        let dir_b = matches!(b, TreeNode::Dir { .. });
        dir_b
            .cmp(&dir_a)
            .then_with(|| a.name().to_lowercase().cmp(&b.name().to_lowercase()))
            .then_with(|| a.name().cmp(b.name()))
    });
    out
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
    fn creates_visible_empty_folders_with_unicode_names() {
        let root = tempdir("create-folder");
        let path = create_folder(&root, &root, "회의 자료").unwrap();
        let parent = Path::new(&path);
        let child = create_folder(&root, parent, "2026.10").unwrap();
        assert!(Path::new(&child).is_dir());
        let tree = scan_tree(&root).unwrap().tree;
        assert!(matches!(&tree[0], TreeNode::Dir { name, children, .. }
            if name == "회의 자료" && children.len() == 1 && children[0].name() == "2026.10"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_creation_preserves_existing_files_and_folders() {
        let root = tempdir("folder-collision");
        fs::write(root.join("Notes"), "original").unwrap();
        assert!(matches!(
            create_folder(&root, &root, "Notes"),
            Err(CreateFolderError::Exists)
        ));
        assert_eq!(fs::read_to_string(root.join("Notes")).unwrap(), "original");
        create_folder(&root, &root, "Archive").unwrap();
        fs::write(root.join("Archive/keep.md"), "keep").unwrap();
        assert!(matches!(
            create_folder(&root, &root, "Archive"),
            Err(CreateFolderError::Exists)
        ));
        assert_eq!(
            fs::read_to_string(root.join("Archive/keep.md")).unwrap(),
            "keep"
        );
        assert_eq!(
            serde_json::to_value(CreateFolderError::Exists).unwrap(),
            serde_json::json!({ "code": "exists" })
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_creation_rejects_invalid_hidden_and_outside_paths() {
        let root = tempdir("folder-paths");
        for name in [
            "",
            " ",
            ".",
            "..",
            "../outside",
            "a/b",
            "a\\b",
            "a\n",
            "a\0",
            " spaced ",
        ] {
            assert!(
                matches!(
                    create_folder(&root, &root, name),
                    Err(CreateFolderError::InvalidName)
                ),
                "{name:?}"
            );
        }
        for name in [
            ".hidden",
            "__cache",
            "node_modules",
            "target",
            "dist",
            "build",
            "out",
            "vendor",
        ] {
            assert!(
                matches!(
                    create_folder(&root, &root, name),
                    Err(CreateFolderError::HiddenName)
                ),
                "{name}"
            );
        }
        assert!(matches!(
            create_folder(&root, root.parent().unwrap(), "Outside"),
            Err(CreateFolderError::Outside)
        ));
        assert!(matches!(
            create_folder(&root, &root.join(".."), "Outside"),
            Err(CreateFolderError::Outside)
        ));
        assert!(create_folder(&root, &root.join("missing"), "Child").is_err());
        fs::create_dir(root.join(".hidden")).unwrap();
        assert!(matches!(
            create_folder(&root, &root.join(".hidden"), "Child"),
            Err(CreateFolderError::Outside)
        ));
        assert!(!root.join("missing").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_creation_uses_the_scanners_depth_boundary() {
        let root = tempdir("folder-depth");
        let mut parent = root.clone();
        for _ in 0..MAX_DEPTH {
            parent.push("level");
        }
        fs::create_dir_all(&parent).unwrap();
        let last_visible = create_folder(&root, &parent, "visible").unwrap();
        assert!(matches!(
            create_folder(&root, Path::new(&last_visible), "invisible"),
            Err(CreateFolderError::Depth)
        ));
        assert!(!Path::new(&last_visible).join("invisible").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn folder_creation_rejects_symlink_children_and_preserves_link_destinations() {
        use std::os::unix::fs::symlink;
        let root = tempdir("folder-symlink");
        let outside = tempdir("folder-symlink-outside");
        symlink(&outside, root.join("link")).unwrap();
        assert!(matches!(
            create_folder(&root, &root.join("link"), "Child"),
            Err(CreateFolderError::Outside)
        ));
        assert!(matches!(
            create_folder(&root, &root, "link"),
            Err(CreateFolderError::Exists)
        ));
        assert!(!outside.join("Child").exists());
        symlink(outside.join("missing"), root.join("dangling")).unwrap();
        assert!(matches!(
            create_folder(&root, &root, "dangling"),
            Err(CreateFolderError::Exists)
        ));
        assert!(fs::symlink_metadata(root.join("dangling"))
            .unwrap()
            .file_type()
            .is_symlink());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn scans_only_markdown_sorting_dirs_first() {
        let d = tempdir("basic");
        fs::write(d.join("b.md"), "x").unwrap();
        fs::write(d.join("a.MARKDOWN"), "x").unwrap();
        fs::write(d.join("notes.txt"), "x").unwrap();
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("sub/inner.md"), "x").unwrap();
        let tree = scan_tree(&d).unwrap().tree;
        let names: Vec<&str> = tree.iter().map(|n| n.name()).collect();
        assert_eq!(names, vec!["sub", "a.MARKDOWN", "b.md"]);
        match &tree[0] {
            TreeNode::Dir { children, .. } => assert_eq!(children.len(), 1),
            _ => panic!("첫 항목은 디렉터리여야 한다"),
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn skips_hidden_and_ignored_but_keeps_empty_folders() {
        let d = tempdir("hidden");
        fs::create_dir_all(d.join(".git")).unwrap();
        fs::write(d.join(".git/config.md"), "x").unwrap();
        fs::create_dir_all(d.join("node_modules/pkg")).unwrap();
        fs::write(d.join("node_modules/pkg/readme.md"), "x").unwrap();
        fs::create_dir_all(d.join("empty-dir")).unwrap();
        fs::write(d.join(".hidden.md"), "x").unwrap();
        fs::write(d.join("ok.md"), "x").unwrap();
        let tree = scan_tree(&d).unwrap().tree;
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].name(), "empty-dir");
        assert_eq!(tree[1].name(), "ok.md");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_root_is_an_error_but_an_empty_root_is_a_valid_scan() {
        let d = tempdir("missing-root");
        let report = scan_tree(&d).unwrap();
        assert!(report.tree.is_empty() && report.issues.is_empty());
        fs::remove_dir_all(&d).unwrap();
        assert!(scan_tree(&d).is_err());
    }

    #[test]
    fn depth_limit_keeps_siblings_and_reports_the_omitted_folder() {
        let d = tempdir("depth-limit");
        fs::create_dir_all(d.join("deep")).unwrap();
        fs::write(d.join("deep/hidden.md"), "deep").unwrap();
        fs::write(d.join("visible.md"), "visible").unwrap();
        let report = scan_with_limits(&d, 0, 20).unwrap();
        assert!(report.tree.iter().any(|node| node.name() == "visible.md"));
        assert!(report.tree.iter().any(|node| node.name() == "deep"));
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].code, "depth");
        assert!(report.issues[0].path.ends_with("deep"));
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn entry_limit_returns_a_bounded_partial_listing() {
        let d = tempdir("entry-limit");
        for i in 0..5 {
            fs::write(d.join(format!("{i}.md")), "x").unwrap();
        }
        let report = scan_with_limits(&d, 12, 2).unwrap();
        assert_eq!(report.tree.len(), 2);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].code, "limit");
        fs::remove_dir_all(d).unwrap();
    }

    #[cfg(unix)]
    #[test]
    // macOS APFS는 잘못된 UTF-8 바이트가 포함된 파일명 생성을 거부한다
    // ("Illegal byte sequence") — Linux ext4에서만 실행.
    #[cfg(not(target_os = "macos"))]
    fn invalid_path_encoding_does_not_discard_readable_siblings() {
        use std::os::unix::ffi::OsStringExt;
        let d = tempdir("path-encoding");
        fs::write(
            d.join(std::ffi::OsString::from_vec(b"bad\xff.md".to_vec())),
            "x",
        )
        .unwrap();
        fs::write(d.join("good.md"), "x").unwrap();
        let report = scan_tree(&d).unwrap();
        assert_eq!(report.tree.len(), 1);
        assert_eq!(report.tree[0].name(), "good.md");
        assert_eq!(report.issues[0].code, "encoding");
        fs::remove_dir_all(d).unwrap();
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
        let tree = scan_tree(&d).unwrap().tree;
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
