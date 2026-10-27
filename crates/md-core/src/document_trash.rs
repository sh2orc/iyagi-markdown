//! Review one workspace document before moving it to the system Trash.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashDocument {
    pub root: String,
    pub path: String,
    pub canonical_root: String,
    pub stamp: String,
    pub size: u64,
}

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", content = "message", rename_all = "camelCase")]
pub enum TrashError {
    #[error("Select a regular Markdown document inside this workspace")]
    Outside,
    #[error("The document changed; review it again")]
    Changed,
    #[error("Close the other application windows before moving this document to Trash")]
    OtherWindows,
    #[error("{0}")]
    Io(String),
}

fn io(error: std::io::Error) -> TrashError {
    TrashError::Io(error.to_string())
}

pub fn review(root: &Path, path: &Path) -> Result<TrashDocument, TrashError> {
    if !root.is_absolute()
        || !path.is_absolute()
        || root
            .components()
            .chain(path.components())
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(TrashError::Outside);
    }
    let relative = path.strip_prefix(root).map_err(|_| TrashError::Outside)?;
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(crate::tree::is_markdown_name)
    {
        return Err(TrashError::Outside);
    }
    let canonical_root = fs::canonicalize(root).map_err(io)?;
    if !canonical_root.is_dir() {
        return Err(TrashError::Outside);
    }
    let mut current = root.to_path_buf();
    // Do not follow descendant links, even if they resolve back into the root.
    for part in relative.components() {
        let Component::Normal(name) = part else {
            return Err(TrashError::Outside);
        };
        if crate::tree::should_skip_dir_name(name.to_str().ok_or(TrashError::Outside)?) {
            return Err(TrashError::Outside);
        }
        current.push(name);
        if fs::symlink_metadata(&current)
            .map_err(io)?
            .file_type()
            .is_symlink()
        {
            return Err(TrashError::Outside);
        }
    }
    let resolved = fs::canonicalize(path).map_err(io)?;
    if !resolved.starts_with(&canonical_root) || resolved == canonical_root {
        return Err(TrashError::Outside);
    }
    let metadata = fs::symlink_metadata(path).map_err(io)?;
    if !metadata.is_file() {
        return Err(TrashError::Outside);
    }
    let modified = metadata
        .modified()
        .map_err(io)?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| TrashError::Io(error.to_string()))?
        .as_nanos();
    #[cfg(unix)]
    let stamp = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            modified,
            metadata.ctime(),
            metadata.ctime_nsec()
        )
    };
    #[cfg(not(unix))]
    let stamp = format!("{modified}");
    Ok(TrashDocument {
        root: root.to_str().ok_or(TrashError::Outside)?.into(),
        path: path.to_str().ok_or(TrashError::Outside)?.into(),
        canonical_root: canonical_root.to_str().ok_or(TrashError::Outside)?.into(),
        stamp,
        size: metadata.len(),
    })
}

/// The caller holds the document-write lock through recheck and native move.
/// External filesystem mutations are not locked by this application mutex.
pub fn apply(
    reviewed: &TrashDocument,
    trash: impl FnOnce(&str) -> Result<(), TrashError>,
) -> Result<(), TrashError> {
    let current = review(Path::new(&reviewed.root), Path::new(&reviewed.path))?;
    if &current != reviewed {
        return Err(TrashError::Changed);
    }
    trash(&reviewed.path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rechecks_identity_and_propagates_trash_failure_without_deleting() {
        let root = std::env::temp_dir().join(format!("md-trash-review-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let path = root.join("document.md");
        fs::write(&path, b"first").unwrap();
        let reviewed = review(&root, &path).unwrap();
        assert!(matches!(
            apply(&reviewed, |_| Err(TrashError::Io("denied".into()))),
            Err(TrashError::Io(_))
        ));
        assert_eq!(fs::read(&path).unwrap(), b"first");
        fs::write(&path, b"changed content").unwrap();
        assert!(matches!(
            apply(&reviewed, |_| panic!("must not trash a changed document")),
            Err(TrashError::Changed)
        ));
        let updated = review(&root, &path).unwrap();
        let mut called = false;
        apply(&updated, |target| {
            assert_eq!(target, path.to_str().unwrap());
            called = true;
            Ok(())
        })
        .unwrap();
        assert!(called);
        assert!(review(&root, &root).is_err());
        assert!(review(&root, &root.join("../outside.md")).is_err());
        let folder = root.join("folder.md");
        fs::create_dir(&folder).unwrap();
        assert!(review(&root, &folder).is_err());
        let hidden = root.join(".hidden.md");
        fs::write(&hidden, b"hidden").unwrap();
        assert!(review(&root, &hidden).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links_and_parent_replacement_after_review() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("md-trash-links-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let folder = root.join("notes");
        fs::create_dir(&folder).unwrap();
        let path = folder.join("document.md");
        fs::write(&path, b"original").unwrap();
        symlink(&path, root.join("linked.md")).unwrap();
        assert!(review(&root, &root.join("linked.md")).is_err());
        let reviewed = review(&root, &path).unwrap();
        fs::rename(&folder, root.join("moved")).unwrap();
        symlink(root.join("moved"), &folder).unwrap();
        assert!(apply(&reviewed, |_| panic!("must not follow a replaced parent")).is_err());
        assert_eq!(
            fs::read(root.join("moved/document.md")).unwrap(),
            b"original"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
