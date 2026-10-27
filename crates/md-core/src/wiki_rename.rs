//! 이름 변경 전의 색인으로 실제 대상을 해석한 뒤 링크 변경을 준비한다.
//! Markdown is parsed to locate links; edits splice the original bytes.
use crate::{
    document_links::Destination,
    markdown_source::{self, Edit},
    search::{ReplaceFailure, ReplacementFile, ReplacementPlan},
    tree::TreeNode,
};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) type Index = HashMap<String, Vec<String>>;

pub struct RenameGuard {
    root: PathBuf,
    from: PathBuf,
    to: PathBuf,
    inventory: Vec<String>,
}

impl RenameGuard {
    pub fn validate(&self) -> std::io::Result<()> {
        if self.from.try_exists()? || !self.to.is_file() {
            return Err(std::io::Error::other(
                "The renamed document changed location. Review links again.",
            ));
        }
        let (_, paths) = inventory(&self.root)?;
        if paths != self.inventory {
            return Err(std::io::Error::other(
                "Workspace files changed. Review renamed links again.",
            ));
        }
        Ok(())
    }
}

pub(crate) fn inventory(root: &Path) -> std::io::Result<(Vec<TreeNode>, Vec<String>)> {
    let scan = crate::tree::scan_tree(root)?;
    if !scan.issues.is_empty() {
        return Err(std::io::Error::other(format!(
            "Cannot resolve links from an incomplete workspace: {}: {}",
            scan.issues[0].path, scan.issues[0].message
        )));
    }
    fn walk(nodes: &[TreeNode], paths: &mut Vec<String>) {
        for node in nodes {
            match node {
                TreeNode::Dir { children, .. } => walk(children, paths),
                TreeNode::File { path, .. } => paths.push(path.clone()),
            }
        }
    }
    let mut paths = Vec::new();
    walk(&scan.tree, &mut paths);
    Ok((scan.tree, paths))
}

pub(crate) fn index(nodes: &[TreeNode]) -> Index {
    fn walk(nodes: &[TreeNode], dir: &str, out: &mut Index) {
        for node in nodes {
            match node {
                TreeNode::Dir { name, children, .. } => {
                    let prefix = if dir.is_empty() {
                        name.clone()
                    } else {
                        format!("{dir}/{name}")
                    };
                    walk(children, &prefix, out);
                }
                TreeNode::File { name, stem, path } => {
                    let relative = if dir.is_empty() {
                        name.clone()
                    } else {
                        format!("{dir}/{name}")
                    };
                    let mut keys = vec![stem.clone(), format!("/{relative}")];
                    if !dir.is_empty() {
                        keys.push(format!("{dir}/{stem}"));
                    }
                    for key in keys {
                        out.entry(key.to_lowercase())
                            .or_default()
                            .push(path.clone());
                    }
                }
            }
        }
    }
    let mut out = Index::new();
    walk(nodes, "", &mut out);
    out
}

pub(crate) fn resolve<'a>(index: &'a Index, name: &str, dir: &Path) -> Option<&'a str> {
    let paths = index.get(&name.replace('\\', "/").to_lowercase())?;
    paths
        .iter()
        .find(|path| Path::new(path).parent() == Some(dir))
        .or_else(|| paths.first())
        .map(String::as_str)
}

// Reconstruct the old traversal order, including collisions affected by the rename.
fn restore_name(nodes: &mut [TreeNode], from: &str, to: &str) {
    for node in nodes.iter_mut() {
        match node {
            TreeNode::Dir { children, .. } => restore_name(children, from, to),
            TreeNode::File { name, stem, path } if path == to => {
                *path = from.to_owned();
                *name = Path::new(from)
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned();
                *stem = Path::new(from)
                    .file_stem()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .to_owned();
            }
            _ => {}
        }
    }
    nodes.sort_by(|a, b| {
        let dir = |node: &TreeNode| matches!(node, TreeNode::Dir { .. });
        dir(b)
            .cmp(&dir(a))
            .then_with(|| a.name().to_lowercase().cmp(&b.name().to_lowercase()))
            .then_with(|| a.name().cmp(b.name()))
    });
}

pub fn prepare(
    root: &Path,
    from: &Path,
    to: &Path,
) -> std::io::Result<(ReplacementPlan, RenameGuard)> {
    let invalid = || {
        std::io::Error::other(
            "Expected two Markdown filenames in the same workspace folder after a rename.",
        )
    };
    let from_s = from.to_str().ok_or_else(invalid)?;
    let to_s = to.to_str().ok_or_else(invalid)?;
    if from == to
        || from.parent() != to.parent()
        || from.try_exists()?
        || !to.is_file()
        || !from.starts_with(root)
        || !to.starts_with(root)
        || from
            .components()
            .chain(to.components())
            .any(|c| matches!(c, std::path::Component::ParentDir))
        || !crate::tree::is_markdown_name(from_s)
        || !crate::tree::is_markdown_name(to_s)
    {
        return Err(invalid());
    }
    let (tree, paths) = inventory(root)?;
    if !paths.iter().any(|path| path == to_s) {
        return Err(invalid());
    }
    let after_index = index(&tree);
    let mut old_tree = tree;
    restore_name(&mut old_tree, from_s, to_s);
    let before_index = index(&old_tree);
    let explicit = format!(
        "/{}",
        to.strip_prefix(root)
            .map_err(|_| invalid())?
            .to_str()
            .ok_or_else(invalid)?
    );
    let stem = to
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(invalid)?;
    let mut plan = ReplacementPlan {
        files: Vec::new(),
        skipped: Vec::new(),
    };
    let mut bytes = 0usize;
    for path in &paths {
        let result = (|| -> Result<Option<ReplacementFile>, String> {
            let mut original = Vec::new();
            std::fs::File::open(path)
                .map_err(|e| e.to_string())?
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut original)
                .map_err(|e| e.to_string())?;
            if original.len() > 4 * 1024 * 1024 {
                return Err("File exceeds the 4 MiB review limit".into());
            }
            let doc =
                crate::io::decode_doc(original, Path::new(path)).map_err(|e| e.to_string())?;
            let dir = Path::new(path).parent().ok_or("Document folder missing")?;
            let replacement = if resolve(&after_index, stem, dir) == Some(to_s) {
                stem
            } else {
                &explicit
            };
            let wiki: Vec<_> = targets(&doc.text)?
                .into_iter()
                .filter(|target| resolve(&before_index, &target.name, dir) == Some(from_s))
                .collect();
            if !wiki.is_empty() && replacement.contains(['[', ']', '#', '|', '\\', '\n', '\r']) {
                return Err("The new filename cannot be represented as a wiki link.".into());
            }
            if !wiki.is_empty() && resolve(&after_index, replacement, dir) != Some(to_s) {
                return Err("The new link target is ambiguous, including filename case. This file was kept.".into());
            }
            let mut edits = crate::markdown_rename::edits(&doc.text, dir, from, to)?;
            edits.extend(wiki.into_iter().map(|target| Edit {
                range: target.start..target.end,
                value: replacement.to_owned(),
            }));
            if edits.is_empty() {
                return Ok(None);
            }
            let count = edits.len();
            let after = markdown_source::apply(&doc.text, &mut edits)?;
            Ok(Some(ReplacementFile {
                path: path.clone(),
                before: doc.text,
                after,
                meta: doc.meta,
                count,
            }))
        })();
        match result {
            Ok(Some(file)) => {
                bytes = bytes
                    .saturating_add(file.before.len())
                    .saturating_add(file.after.len());
                if bytes > 16 * 1024 * 1024 || plan.files.len() >= 500 {
                    return Err(std::io::Error::other(
                        "Link review exceeds 500 files or 16 MiB.",
                    ));
                }
                plan.files.push(file);
            }
            Ok(None) => {}
            Err(message) => plan.skipped.push(ReplaceFailure {
                path: path.clone(),
                message,
            }),
        }
    }
    Ok((
        plan,
        RenameGuard {
            root: root.into(),
            from: from.into(),
            to: to.into(),
            inventory: paths,
        },
    ))
}

pub(crate) struct WikiTarget {
    pub name: String,
    pub start: usize,
    pub end: usize,
}

pub(crate) fn targets(text: &str) -> Result<Vec<WikiTarget>, String> {
    let edits: Vec<_> = crate::document_links::targets(text)?
        .into_iter()
        .filter_map(|target| match target.destination {
            Destination::Wiki(name) => Some(WikiTarget {
                name,
                start: target.start,
                end: target.end,
            }),
            Destination::Url(_) => None,
        })
        .collect();
    if edits.windows(2).any(|pair| pair[0].end > pair[1].start) {
        return Err("Overlapping wiki links. The document was kept.".into());
    }
    Ok(edits)
}

#[cfg(test)]
fn rewrite(
    text: &str,
    matches: impl Fn(&str) -> bool,
    replacement: &str,
) -> Result<(String, usize), String> {
    let mut edits: Vec<_> = targets(text)?
        .into_iter()
        .filter(|target| matches(&target.name))
        .map(|target| Edit {
            range: target.start..target.end,
            value: replacement.into(),
        })
        .collect();
    let count = edits.len();
    let out = markdown_source::apply(text, &mut edits)?;
    Ok((out, count))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn workspace() -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "iyagi-rename-review-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        root
    }

    #[test]
    fn source_edits_preserve_unicode_spaces_aliases_and_exclude_code_and_metadata() {
        let text = "---\ntitle: '[[노트]]'\n...\n한글 [[ 노트 #제목|보여줄 말 ]] 뒤\n`[[노트]]` \\[[노트]]\n```markdown\n[[노트]]\n```\n<!-- [[노트]] -->\n    [[노트]]\n";
        let (after, count) = rewrite(text, |name| name == "노트", "새 이름").unwrap();
        assert_eq!(count, 1);
        assert_eq!(after, text.replace("[[ 노트 #", "[[ 새 이름 #"));
        let multiline = "``a\n[[노트]]\nb``\n\n> [[노트|말]]\n";
        let (after, count) = rewrite(multiline, |name| name == "노트", "새 이름").unwrap();
        assert_eq!(count, 1);
        assert_eq!(after, multiline.replace("> [[노트|", "> [[새 이름|"));
        assert!(targets("---\ntitle: '[[노트]]'\n").unwrap().is_empty());
    }

    #[test]
    fn rename_resolves_duplicate_names_and_preserves_bom_crlf_and_new_target_identity() {
        let root = workspace();
        std::fs::write(root.join("a/new.md"), "# renamed").unwrap();
        std::fs::write(root.join("b/note.md"), "# other note").unwrap();
        std::fs::write(root.join("b/new.md"), "# other new").unwrap();
        std::fs::write(root.join("a/ref.md"), "[[note#heading|label]]").unwrap();
        let original = b"\xef\xbb\xbf[[note]] and [[a/note]] and [[/a/note.md]]\r\n";
        std::fs::write(root.join("b/ref.md"), original).unwrap();
        let (plan, guard) =
            prepare(&root, &root.join("a/note.md"), &root.join("a/new.md")).unwrap();
        assert_eq!(std::fs::read(root.join("b/ref.md")).unwrap(), original);
        assert!(plan.skipped.is_empty());
        assert_eq!(plan.files.len(), 2);
        let other = plan
            .files
            .iter()
            .find(|file| file.path.ends_with("b/ref.md"))
            .unwrap();
        assert_eq!(
            other.after,
            "[[note]] and [[/a/new.md]] and [[/a/new.md]]\n"
        );
        assert_eq!(other.count, 2);
        guard.validate().unwrap();
        let mut backed_up = Vec::new();
        let report = crate::search::apply_replacement(plan, |file| {
            backed_up.push(file.path.clone());
            Ok(())
        });
        assert_eq!(backed_up.len(), 2);
        assert_eq!(report.applied.len(), 2);
        assert!(report.failed.is_empty());
        assert_eq!(
            std::fs::read(root.join("b/ref.md")).unwrap(),
            b"\xef\xbb\xbf[[note]] and [[/a/new.md]] and [[/a/new.md]]\r\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a/ref.md")).unwrap(),
            "[[new#heading|label]]"
        );
        let hits =
            crate::search::find_backlinks(&root, root.join("a/new.md").to_str().unwrap(), 100)
                .unwrap();
        assert!(hits.iter().any(|hit| hit.path.ends_with("b/ref.md")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changed_workspace_and_file_and_failed_backup_do_not_overwrite_reviewed_sources() {
        let root = workspace();
        std::fs::write(root.join("a/new.md"), "new").unwrap();
        std::fs::write(root.join("a/ref.md"), "[[note]]").unwrap();
        let (plan, guard) =
            prepare(&root, &root.join("a/note.md"), &root.join("a/new.md")).unwrap();
        std::fs::write(root.join("b/note.md"), "new collision").unwrap();
        assert!(guard.validate().is_err());
        std::fs::write(root.join("a/ref.md"), "newer edit [[note]]").unwrap();
        let report = crate::search::apply_replacement(plan, |_| Ok(()));
        assert!(report.applied.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert_eq!(
            std::fs::read_to_string(root.join("a/ref.md")).unwrap(),
            "newer edit [[note]]"
        );
        let (plan, _) = prepare(&root, &root.join("a/note.md"), &root.join("a/new.md")).unwrap();
        let report =
            crate::search::apply_replacement(plan, |_| Err(std::io::Error::other("backup full")));
        assert!(report.applied.is_empty());
        assert_eq!(report.failed.len(), 1);
        assert_eq!(
            std::fs::read_to_string(root.join("a/ref.md")).unwrap(),
            "newer edit [[note]]"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_old_path_and_unrepresentable_target_fail_before_writing() {
        let root = workspace();
        std::fs::write(root.join("a/new.md"), "new").unwrap();
        std::fs::write(root.join("a/note.md"), "another file").unwrap();
        assert!(prepare(&root, &root.join("a/note.md"), &root.join("a/new.md")).is_err());
        std::fs::write(root.join("a/unsafe#name.md"), "new").unwrap();
        std::fs::write(root.join("a/ref.md"), "[[old]]").unwrap();
        let (plan, _) = prepare(
            &root,
            &root.join("a/old.md"),
            &root.join("a/unsafe#name.md"),
        )
        .unwrap();
        assert!(plan.files.is_empty());
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(
            std::fs::read_to_string(root.join("a/ref.md")).unwrap(),
            "[[old]]"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mixed_link_kinds_share_one_plan_and_preserve_encoding_on_write() {
        let root = workspace();
        std::fs::write(root.join("a/new.md"), "[self](note.md)").unwrap();
        let original = b"\xef\xbb\xbf[[a/note#heading|label]] [inline](../a/note.md#heading)\r\n\r\n[reference][id]\r\n\r\n[id]: ../a/note.md \"title\"\r\n";
        std::fs::write(root.join("b/ref.md"), original).unwrap();
        std::fs::write(root.join("b/note.md"), "other document").unwrap();
        let (plan, _) = prepare(&root, &root.join("a/note.md"), &root.join("a/new.md")).unwrap();
        assert!(plan.skipped.is_empty());
        assert_eq!(plan.files.len(), 2);
        assert_eq!(
            plan.files
                .iter()
                .find(|f| f.path.ends_with("b/ref.md"))
                .unwrap()
                .count,
            3
        );
        assert_eq!(std::fs::read(root.join("b/ref.md")).unwrap(), original);
        let report = crate::search::apply_replacement(plan, |_| Ok(()));
        assert!(report.failed.is_empty());
        assert_eq!(std::fs::read(root.join("b/ref.md")).unwrap(),
            b"\xef\xbb\xbf[[new#heading|label]] [inline](../a/new.md#heading)\r\n\r\n[reference][id]\r\n\r\n[id]: ../a/new.md \"title\"\r\n");
        assert_eq!(
            std::fs::read_to_string(root.join("a/new.md")).unwrap(),
            "[self](new.md)"
        );
        assert!(
            prepare(&root, &root.join("a/note.md"), &root.join("a/new.md"))
                .unwrap()
                .0
                .files
                .is_empty()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn special_filename_is_allowed_for_markdown_only_links() {
        let root = workspace();
        std::fs::write(root.join("a/new#name.md"), "new").unwrap();
        std::fs::write(root.join("b/ref.md"), "[link](../a/old.md#anchor)").unwrap();
        let (plan, _) =
            prepare(&root, &root.join("a/old.md"), &root.join("a/new#name.md")).unwrap();
        assert!(plan.skipped.is_empty());
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].after, "[link](../a/new%23name.md#anchor)");
        std::fs::remove_dir_all(root).unwrap();
    }
}
