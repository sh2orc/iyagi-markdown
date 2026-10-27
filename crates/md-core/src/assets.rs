//! 이미지 정리 후보: 완전한 문서 스캔 후 검토한 파일만 재확인한다.
//! 파일명 기반의 보수적인 참조 판정이다. 참조처럼 보이는 일반 텍스트도 보존한다.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use unicode_normalization::UnicodeNormalization;

pub const MAX_TEXT_BYTES: usize = 64 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanAsset {
    pub path: String,
    pub size: u64,
    /// 메타데이터 정체성: 같은 이름으로 교체된 파일을 이전 검토로 정리하지 않는다.
    pub stamp: String,
}

#[derive(Debug, Serialize)]
pub struct AssetFailure {
    pub path: String,
    pub message: String,
}
#[derive(Debug, Default, Serialize)]
pub struct TrashReport {
    pub moved: Vec<String>,
    pub failed: Vec<AssetFailure>,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn image_name(name: &str) -> bool {
    matches!(
        name.rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "avif" | "heic" | "tif" | "tiff"
    )
}

fn identity(path: &Path) -> io::Result<OrphanAsset> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(invalid("The asset is not a regular file"));
    }
    let modified = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| invalid(error.to_string()))?
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
    Ok(OrphanAsset {
        path: path
            .to_str()
            .ok_or_else(|| invalid("Unsupported file name encoding"))?
            .into(),
        size: metadata.len(),
        stamp,
    })
}

fn walk(
    dir: &Path,
    depth: usize,
    in_assets: bool,
    count: &mut usize,
    docs: &mut Vec<PathBuf>,
    assets: &mut Vec<OrphanAsset>,
) -> io::Result<()> {
    if depth > 32 {
        return Err(invalid(
            "Folder depth limit reached; no cleanup was performed",
        ));
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        *count += 1;
        if *count > MAX_ENTRIES {
            return Err(invalid(
                "Workspace is too large for a complete cleanup scan",
            ));
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| invalid("Unsupported file name encoding"))?;
        let kind = entry.file_type()?;
        // VCS 내부는 제외한다. 숨김 문서와 일반 빌드 디렉터리도 검사한다.
        if kind.is_dir() && matches!(name.as_str(), ".git" | ".hg" | ".svn") {
            continue;
        }
        if kind.is_symlink() {
            return Err(invalid(format!(
                "Symbolic link prevents a complete scan: {}",
                entry.path().display()
            )));
        }
        if kind.is_dir() {
            walk(
                &entry.path(),
                depth + 1,
                in_assets || name.eq_ignore_ascii_case("assets"),
                count,
                docs,
                assets,
            )?;
        } else if kind.is_file() {
            if crate::tree::is_markdown_name(&name) {
                docs.push(entry.path());
            }
            if in_assets && !name.starts_with('.') && image_name(&name) {
                assets.push(identity(&entry.path())?);
            }
        }
    }
    Ok(())
}

/// URL/HTML/Markdown 표기 차이를 처리한다. 해석할 수 없는 엔티티는 미참조
/// 판정 근거가 부족하므로 검사를 실패시킨다.
fn reference_text(text: &str) -> io::Result<String> {
    let decoded = crate::links::percent_decode(text);
    let mut output = String::with_capacity(decoded.len());
    let mut rest = decoded.as_str();
    while let Some(at) = rest.find('&') {
        output.push_str(&rest[..at]);
        rest = &rest[at + 1..];
        let entity = rest
            .as_bytes()
            .iter()
            .take(33)
            .position(|byte| *byte == b';')
            .map(|end| (&rest[..end], end));
        if let Some((name, end)) = entity {
            let value = match name {
                "amp" => Some('&'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "nbsp" => Some('\u{a0}'),
                _ if name.starts_with("#x") || name.starts_with("#X") => {
                    u32::from_str_radix(&name[2..], 16)
                        .ok()
                        .and_then(char::from_u32)
                }
                _ if name.starts_with('#') => {
                    name[1..].parse::<u32>().ok().and_then(char::from_u32)
                }
                _ => None,
            };
            if let Some(value) = value {
                output.push(value);
                rest = &rest[end + 1..];
                continue;
            }
            if name.starts_with('#')
                || (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric()))
            {
                return Err(invalid(
                    "Unsupported HTML entity in document; inspect image references manually",
                ));
            }
        }
        output.push('&');
    }
    output.push_str(rest);
    // Markdown 이스케이프는 참조를 놓치기보다 후보를 더 보존하는 쪽으로 처리한다.
    // 원문/URL 복호/엔티티 복호를 모두 포함해 이중 인코딩된 실제 파일명도 보존한다.
    let variants = format!(
        "{text}\n{decoded}\n{output}\n{}",
        crate::links::percent_decode(&output)
    );
    Ok(variants
        .replace('\\', "")
        .nfc()
        .collect::<String>()
        .to_lowercase())
}

pub fn find_orphan_assets(root: &Path, extra_texts: &[String]) -> io::Result<Vec<OrphanAsset>> {
    let root = fs::canonicalize(root)?;
    if !root.is_dir() {
        return Err(invalid("Workspace is not a directory"));
    }
    let mut docs = Vec::new();
    let mut assets = Vec::new();
    let mut count = 0;
    walk(&root, 0, false, &mut count, &mut docs, &mut assets)?;
    let mut candidates: Vec<_> = assets
        .into_iter()
        .map(|asset| {
            let name = Path::new(&asset.path)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .replace('\\', "")
                .nfc()
                .collect::<String>()
                .to_lowercase();
            (asset, name)
        })
        .collect();
    let mut budget = MAX_TEXT_BYTES;
    let mut match_budget = 256usize * 1024 * 1024;
    let mut check = |text: &str| -> io::Result<()> {
        if text.len() as u64 > MAX_FILE_BYTES {
            return Err(invalid(
                "Document or recovery draft is too large to inspect",
            ));
        }
        budget = budget
            .checked_sub(text.len())
            .ok_or_else(|| invalid("Document text exceeds the cleanup scan limit"))?;
        let decoded = reference_text(text)?;
        match_budget = match_budget
            .checked_sub(decoded.len().saturating_mul(candidates.len()))
            .ok_or_else(|| invalid("Image reference matching exceeds the cleanup scan limit"))?;
        candidates.retain(|(_, name)| !decoded.contains(name.as_str()));
        Ok(())
    };
    for text in extra_texts {
        check(text)?;
    }
    for doc in docs {
        let mut bytes = Vec::new();
        fs::File::open(&doc)?
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(invalid(format!(
                "Document is too large to inspect: {}",
                doc.display()
            )));
        }
        let text = String::from_utf8(bytes)
            .map_err(|_| invalid(format!("Document is not UTF-8: {}", doc.display())))?;
        check(&text)?;
    }
    let mut result: Vec<_> = candidates.into_iter().map(|(asset, _)| asset).collect();
    result.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));
    Ok(result)
}

/// 재검사한 후보와 완전히 일치할 때만 적용한다. 콜백은 휴지통 이동만 수행한다.
pub fn trash_reviewed(
    root: &Path,
    reviewed: &[OrphanAsset],
    extra_texts: &[String],
    mut trash: impl FnMut(&str) -> Result<(), String>,
) -> io::Result<TrashReport> {
    let current = find_orphan_assets(root, extra_texts)?;
    let current: std::collections::HashMap<_, _> = current
        .into_iter()
        .map(|asset| (asset.path.clone(), asset))
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut report = TrashReport::default();
    for asset in reviewed {
        if !seen.insert(asset.path.clone()) {
            continue;
        }
        let result = if current.get(&asset.path) != Some(asset) {
            Err("The asset changed, is referenced, or is outside the reviewed workspace".into())
        } else {
            // 경로 중간이 심볼릭 링크로 바뀌지 않았는지도 다시 확인한다.
            let path = Path::new(&asset.path);
            if fs::canonicalize(path).ok().as_deref() != Some(path)
                || identity(path).ok().as_ref() != Some(asset)
            {
                Err("The asset changed after scanning".into())
            } else {
                trash(&asset.path)
            }
        };
        match result {
            Ok(()) => report.moved.push(asset.path.clone()),
            Err(message) => report.failed.push(AssetFailure {
                path: asset.path.clone(),
                message,
            }),
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("md-assets-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("nested/assets")).unwrap();
        fs::canonicalize(root).unwrap()
    }

    #[test]
    fn finds_real_images_in_nested_assets_and_preserves_encoded_references() {
        let root = workspace("references");
        for name in [
            "unused.png",
            "space image.png",
            "a&b.png",
            "é.png",
            "draft.png",
        ] {
            fs::write(root.join("nested/assets").join(name), b"image").unwrap();
        }
        fs::write(
            root.join("nested/note.md"),
            "![](assets/space%20image.png)\n<img src='assets/a&amp;b.png'>\n![[e\u{301}.png]]",
        )
        .unwrap();
        fs::write(root.join("outside.png"), b"outside assets").unwrap();
        let items = find_orphan_assets(&root, &["![](assets/draft.png)".into()]).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].path.ends_with("/unused.png"));
        assert_eq!(items[0].size, 5);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_document_encoding_prevents_cleanup_instead_of_claiming_no_references() {
        let root = workspace("encoding");
        fs::write(root.join("nested/assets/a.png"), b"image").unwrap();
        fs::write(root.join("bad.md"), [0xff, 0xfe]).unwrap();
        assert!(find_orphan_assets(&root, &[]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn new_references_changed_files_and_outside_paths_are_not_moved() {
        let root = workspace("recheck");
        let a = root.join("nested/assets/a.png");
        let b = root.join("nested/assets/b.png");
        fs::write(&a, b"a").unwrap();
        fs::write(&b, b"b").unwrap();
        let mut reviewed = find_orphan_assets(&root, &[]).unwrap();
        fs::write(root.join("new.md"), "![](nested/assets/a.png)").unwrap();
        fs::write(&b, b"changed image").unwrap();
        let outside = root.join("outside.png");
        fs::write(&outside, b"outside").unwrap();
        reviewed.push(identity(&outside).unwrap());
        let mut called = false;
        let report = trash_reviewed(&root, &reviewed, &[], |_| {
            called = true;
            Ok(())
        })
        .unwrap();
        assert!(!called);
        assert!(report.moved.is_empty());
        assert_eq!(report.failed.len(), 3);
        assert!(a.exists() && b.exists() && outside.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn trash_failure_is_reported_without_deleting_the_original() {
        let root = workspace("trash-failure");
        let path = root.join("nested/assets/a.png");
        fs::write(&path, b"image").unwrap();
        let reviewed = find_orphan_assets(&root, &[]).unwrap();
        let report =
            trash_reviewed(&root, &reviewed, &[], |_| Err("Trash unavailable".into())).unwrap();
        assert_eq!(report.failed.len(), 1);
        assert!(report.moved.is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"image");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selection_and_partial_results_are_preserved() {
        let root = workspace("partial");
        for name in ["a.png", "b.png", "c.png"] {
            fs::write(root.join("nested/assets").join(name), b"x").unwrap();
        }
        let reviewed = find_orphan_assets(&root, &[]).unwrap();
        let mut paths = Vec::new();
        // OS 휴지통 대신 콜백의 호출/결과만 검사한다. 실제 파일은 이동하지 않는다.
        let report = trash_reviewed(&root, &reviewed[..2], &[], |path| {
            paths.push(path.to_owned());
            if path.ends_with("/b.png") {
                Err("unavailable".into())
            } else {
                Ok(())
            }
        })
        .unwrap();
        assert_eq!(paths.len(), 2);
        assert_eq!(report.moved.len(), 1);
        assert_eq!(report.failed.len(), 1);
        assert!(!paths.iter().any(|path| path.ends_with("/c.png")));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_assets_are_not_cleanup_targets() {
        let root = workspace("symlink");
        fs::write(root.join("original.png"), b"image").unwrap();
        std::os::unix::fs::symlink(
            root.join("original.png"),
            root.join("nested/assets/link.png"),
        )
        .unwrap();
        assert!(find_orphan_assets(&root, &[]).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
