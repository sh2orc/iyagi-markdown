//! Inspect an editor buffer against the workspace and actual filesystem.
use crate::{
    document_links::{self, Destination},
    links::{self, LinkTarget},
    tree::ScanIssue,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Wiki,
    File,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingLink {
    pub kind: Kind,
    pub name: String,
    /// UTF-16 offset for CodeMirror; comrak source positions are UTF-8 bytes.
    pub from: usize,
    pub line: usize,
    pub create_path: Option<String>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub links: Vec<MissingLink>,
    pub issues: Vec<ScanIssue>,
    pub checked: usize,
}

fn source_dir(root: &Path, source: Option<&Path>) -> io::Result<PathBuf> {
    if !root.is_absolute() {
        return Err(io::Error::other("Open an absolute workspace folder."));
    }
    match source {
        Some(path)
            if path.is_absolute()
                && path.starts_with(root)
                && !path.components().any(|c| matches!(c, Component::ParentDir)) =>
        {
            path.parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| io::Error::other("Document folder missing"))
        }
        Some(_) => Err(io::Error::other("The document is outside this workspace.")),
        None => Ok(root.into()),
    }
}

// The nearest existing ancestor must remain in the real workspace. Do not inspect
// or offer creation through a symlink pointing outside it.
fn contained(root: &Path, path: &Path) -> io::Result<()> {
    if !path.starts_with(root) || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(io::Error::other("Target is outside the workspace."));
    }
    let real_root = root.canonicalize()?;
    let mut candidate = path;
    loop {
        match candidate.canonicalize() {
            Ok(real) if real.starts_with(&real_root) => return Ok(()),
            Ok(_) => return Err(io::Error::other("Target resolves outside the workspace.")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // A dangling symlink is not an ordinary missing file.
                if std::fs::symlink_metadata(candidate).is_ok_and(|m| m.file_type().is_symlink()) {
                    return Err(io::Error::other(
                        "Target contains a dangling symbolic link.",
                    ));
                }
                candidate = candidate.parent().ok_or(error)?;
            }
            Err(error) => return Err(error),
        }
    }
}

fn target_path(root: &Path, dir: &Path, kind: Kind, name: &str) -> Option<PathBuf> {
    match kind {
        Kind::File => match links::resolve(name, dir) {
            LinkTarget::Markdown { path, .. } => Some(path),
            _ => None,
        },
        Kind::Wiki => {
            if name.is_empty()
                || name.contains(['[', ']', '#', '|', '\\', '\0'])
                || name.chars().any(char::is_control)
            {
                return None;
            }
            let explicit = name.starts_with('/');
            let relative = name.strip_prefix('/').unwrap_or(name);
            if relative.is_empty()
                || relative
                    .split('/')
                    .any(|part| part.is_empty() || matches!(part, "." | ".."))
            {
                return None;
            }
            if explicit {
                crate::tree::is_markdown_name(relative).then(|| root.join(relative))
            } else {
                // A wiki target is a stem, not a URL. Avoid creating a misleading
                // double extension for a name that looks like a filename.
                if crate::tree::is_markdown_name(relative) {
                    return None;
                }
                Some(if relative.contains('/') { root } else { dir }.join(format!("{relative}.md")))
            }
        }
    }
}

fn creation_target(root: &Path, dir: &Path, kind: Kind, name: &str) -> io::Result<PathBuf> {
    let path = target_path(root, dir, kind, name)
        .ok_or_else(|| io::Error::other("This link cannot create a Markdown document."))?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| io::Error::other("Target is outside the workspace."))?;
    if !path.to_str().is_some_and(crate::tree::is_markdown_name)
        || relative.components().any(|part| match part {
            Component::Normal(name) => name.to_str().is_none_or(|name| {
                crate::tree::should_skip_dir_name(name) || name.chars().any(char::is_control)
            }),
            _ => false,
        })
    {
        return Err(io::Error::other("Choose a visible Markdown document path."));
    }
    contained(root, &path)?;
    if !path.parent().is_some_and(Path::is_dir) {
        return Err(io::Error::other(
            "The destination folder must already exist.",
        ));
    }
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path),
        Err(error) => Err(error),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "The destination already exists.",
        )),
    }
}

pub fn inspect(root: &Path, source: Option<&Path>, text: &str) -> io::Result<Report> {
    if text.len() > 4 * 1024 * 1024 {
        return Err(io::Error::other("Link inspection exceeds 4 MiB."));
    }
    let dir = source_dir(root, source)?;
    contained(root, &dir)?;
    let (tree, _) = crate::wiki_rename::inventory(root)?;
    let index = crate::wiki_rename::index(&tree);
    let targets = document_links::targets(text).map_err(io::Error::other)?;
    if targets.len() > 2000 {
        return Err(io::Error::other("Link inspection exceeds 2,000 uses."));
    }
    let mut report = Report::default();
    let mut existence: HashMap<PathBuf, Result<bool, String>> = HashMap::new();
    let mut issue_paths = std::collections::HashSet::new();
    let mut byte_cursor = 0;
    let mut utf16_cursor = 0;
    for target in targets {
        utf16_cursor += text[byte_cursor..target.start].encode_utf16().count();
        byte_cursor = target.start;
        let (kind, name, missing) = match target.destination {
            Destination::Wiki(name) => {
                report.checked += 1;
                let missing = crate::wiki_rename::resolve(&index, &name, &dir).is_none();
                (Kind::Wiki, name, missing)
            }
            Destination::Url(url) => {
                let path = match links::resolve(&url, &dir) {
                    LinkTarget::Markdown { path, .. } | LinkTarget::Asset { path } => path,
                    _ => continue,
                };
                report.checked += 1;
                let found = existence.entry(path.clone()).or_insert_with(|| {
                    contained(root, &path).map_err(|e| e.to_string())?;
                    match std::fs::metadata(&path) {
                        Ok(_) => Ok(true),
                        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
                        Err(error) => Err(error.to_string()),
                    }
                });
                match found {
                    Ok(found) => (Kind::File, url, !*found),
                    Err(message) => {
                        if issue_paths.insert(path.clone()) {
                            report.issues.push(ScanIssue {
                                path: path.to_string_lossy().into_owned(),
                                code: "unverified".into(),
                                message: message.clone(),
                            });
                        }
                        continue;
                    }
                }
            }
        };
        if missing {
            let create_path = creation_target(root, &dir, kind, &name)
                .ok()
                .and_then(|path| path.to_str().map(str::to_owned));
            report.links.push(MissingLink {
                kind,
                name,
                from: utf16_cursor,
                line: target.line,
                create_path,
            });
        }
    }
    Ok(report)
}

/// Re-resolve and validate at the write boundary, using a missing-only atomic write.
pub fn create(root: &Path, source: Option<&Path>, kind: Kind, name: &str) -> io::Result<PathBuf> {
    if name.len() > 4096 {
        return Err(io::Error::other("Link target is too long."));
    }
    let dir = source_dir(root, source)?;
    let (tree, _) = crate::wiki_rename::inventory(root)?;
    if matches!(kind, Kind::Wiki)
        && crate::wiki_rename::resolve(&crate::wiki_rename::index(&tree), name, &dir).is_some()
    {
        return Err(io::Error::other(
            "This wiki link now resolves. Inspect links again.",
        ));
    }
    let path = creation_target(root, &dir, kind, name)?;
    crate::io::write_doc_checked(
        &path,
        "",
        crate::io::DocMeta {
            had_bom: false,
            crlf: false,
        },
        &crate::io::WriteExpectation::Missing,
    )
    .map_err(io::Error::other)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "iyagi-link-inspection-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(path.join("workspace/sub")).unwrap();
            Self(path)
        }
        fn root(&self) -> PathBuf {
            self.0.join("workspace")
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn real_assets_reference_uses_and_utf16_offsets_are_preserved() {
        let w = Workspace::new();
        let root = w.root();
        fs::write(root.join("image one.png"), "image").unwrap();
        fs::write(root.join("present.md"), "present").unwrap();
        let text = "---\ntitle: '[[metadata]]'\n---\n😀 한글 [use][id]\n\n[id]: missing.md\n[unused]: not-used.md\n\n\
            ![image](image%20one.png) [[present]] `[[code]]` [[new]]\n";
        let report = inspect(&root, Some(&root.join("source.md")), text).unwrap();
        assert!(report.issues.is_empty());
        assert_eq!(report.links.len(), 2);
        assert_eq!(report.links[0].name, "missing.md");
        assert_eq!(report.links[0].line, 4);
        assert_eq!(
            report.links[0].from,
            text[..text.find("[use]").unwrap()].encode_utf16().count()
        );
        assert_eq!(
            report.links[0].create_path.as_deref(),
            root.join("missing.md").to_str()
        );
        assert_eq!(report.links[1].name, "new");
        assert_eq!(report.checked, 4);
    }

    #[test]
    fn missing_assets_and_outside_paths_never_offer_note_creation() {
        let w = Workspace::new();
        let root = w.root();
        let report = inspect(
            &root,
            None,
            "![missing](image.png) [outside](../else.md) [web](https://example.com/x)\n\
            [anchor](#heading) [custom](custom:page.md) [[../escape]] [sub](absent/new.md)",
        )
        .unwrap();
        assert_eq!(report.links.len(), 3);
        assert!(report.links.iter().all(|link| link.create_path.is_none()));
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].code, "unverified");
        for (kind, name) in [
            (Kind::File, "image.png"),
            (Kind::File, "../else.md"),
            (Kind::Wiki, "../escape"),
            (Kind::File, "absent/new.md"),
            (Kind::Wiki, "note.md"),
        ] {
            assert!(create(&root, None, kind, name).is_err());
        }
        assert!(!w.0.join("else.md").exists());
    }

    #[test]
    fn creation_uses_the_link_destination_and_cannot_replace_existing_files() {
        let w = Workspace::new();
        let root = w.root();
        let source = root.join("sub/source.md");
        let created = create(&root, Some(&source), Kind::File, "../new%20name.md#heading").unwrap();
        assert_eq!(created, root.join("new name.md"));
        fs::write(&created, "keep").unwrap();
        assert!(create(&root, Some(&source), Kind::File, "../new%20name.md").is_err());
        assert_eq!(fs::read_to_string(&created).unwrap(), "keep");
        let wiki = create(&root, Some(&source), Kind::Wiki, "local").unwrap();
        assert_eq!(wiki, root.join("sub/local.md"));
        assert!(create(&root, Some(&source), Kind::Wiki, "local").is_err());
        assert_eq!(
            create(&root, Some(&source), Kind::Wiki, "/sub/explicit.md").unwrap(),
            root.join("sub/explicit.md")
        );
        assert_eq!(
            create(&root, None, Kind::Wiki, "sub/stem").unwrap(),
            root.join("sub/stem.md")
        );
    }

    #[test]
    fn incomplete_workspace_and_invalid_source_are_errors_not_all_clear() {
        let w = Workspace::new();
        let root = w.root();
        assert!(inspect(&root, Some(&w.0.join("outside.md")), "[a](missing.md)").is_err());
        let mut deep = root.clone();
        for _ in 0..13 {
            deep = deep.join("nested");
        }
        fs::create_dir_all(deep).unwrap();
        assert!(inspect(&root, None, "[[missing]]").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn outside_and_dangling_symlinks_are_unverified_and_cannot_create_files() {
        use std::os::unix::fs::symlink;
        let w = Workspace::new();
        let root = w.root();
        fs::create_dir(w.0.join("outside")).unwrap();
        symlink(w.0.join("outside"), root.join("alias")).unwrap();
        symlink(w.0.join("absent"), root.join("dangling")).unwrap();
        let report = inspect(&root, None, "[a](alias/new.md) [b](dangling/new.md)").unwrap();
        assert!(report.links.is_empty());
        assert_eq!(report.issues.len(), 2);
        assert!(create(&root, None, Kind::File, "alias/new.md").is_err());
        assert!(create(&root, None, Kind::File, "dangling/new.md").is_err());
        assert!(!w.0.join("outside/new.md").exists());
    }
}
