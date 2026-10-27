//! Bounded image copies with unique, no-clobber destinations.
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic"];

pub fn clipboard_extension(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/bmp" => Some("bmp"),
        "image/heic" => Some("heic"),
        _ => None,
    }
}

pub fn save_bytes(dir: &Path, stem: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    if !EXTENSIONS.contains(&ext) {
        return Err(format!("Unsupported image extension: {ext}"));
    }
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image must contain between 1 byte and 32 MiB".into());
    }
    if !dir.is_absolute() || !fs::metadata(dir).map_err(|e| e.to_string())?.is_dir() {
        return Err("Image destination must be an existing absolute directory".into());
    }
    let assets = dir.join("assets");
    match fs::create_dir(&assets) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    // Do not silently import into an assets symlink or an unexpected file.
    if !fs::symlink_metadata(&assets)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_dir()
    {
        return Err("The assets destination is not a regular directory".into());
    }
    let clean: String = stem
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-')
        .take(40)
        .collect();
    let clean = if clean.is_empty() {
        "image"
    } else {
        clean.as_str()
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    for _ in 0..32 {
        let path = assets.join(format!(
            "{clean}-{stamp}-{}-{}.{ext}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        match crate::io::write_bytes_new(&path, bytes) {
            Ok(()) => return Ok(path),
            Err(crate::io::DocError::Conflict { .. }) => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not allocate a new image filename".into())
}

pub fn import_file(src: &Path, dir: &Path) -> Result<PathBuf, String> {
    let ext = src
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("Unsupported image extension: {ext}"));
    }
    let metadata = fs::metadata(src).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Err("Image must be a regular file between 1 byte and 32 MiB".into());
    }
    let file = fs::File::open(src).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Image is not a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    save_bytes(
        dir,
        src.file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("image"),
        &ext,
        &bytes,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "iyagi-images-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn clipboard_mime_uses_explicit_extensions() {
        assert_eq!(clipboard_extension("image/png"), Some("png"));
        assert_eq!(clipboard_extension("image/jpeg"), Some("jpg"));
        assert_eq!(clipboard_extension("image/svg+xml"), Some("svg"));
        assert_eq!(clipboard_extension("image/../../png"), None);
        assert_eq!(clipboard_extension("application/octet-stream"), None);
    }

    #[test]
    fn copies_are_distinct_and_existing_bytes_are_preserved() {
        let root = Workspace::new();
        let source = root.0.join("사진 (원본).PNG");
        fs::write(&source, b"original").unwrap();
        let first = import_file(&source, &root.0).unwrap();
        let second = import_file(&source, &root.0).unwrap();
        assert_ne!(first, second);
        assert!(matches!(
            crate::io::write_bytes_new(&first, b"replacement"),
            Err(crate::io::DocError::Conflict { .. })
        ));
        for path in [&source, &first, &second] {
            assert_eq!(fs::read(path).unwrap(), b"original");
        }
    }

    #[test]
    fn rejects_empty_oversize_and_non_file_sources_without_copying() {
        let root = Workspace::new();
        let source = root.0.join("large.png");
        let file = fs::File::create(&source).unwrap();
        assert!(import_file(&source, &root.0).is_err());
        file.set_len(MAX_IMAGE_BYTES as u64 + 1).unwrap();
        assert!(import_file(&source, &root.0).is_err());
        let folder = root.0.join("folder.png");
        fs::create_dir(&folder).unwrap();
        assert!(import_file(&folder, &root.0).is_err());
        assert!(!root.0.join("assets").exists());
        assert!(save_bytes(&root.0, "bad", "../png", b"x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_assets_symlink() {
        let root = Workspace::new();
        let other = Workspace::new();
        std::os::unix::fs::symlink(&other.0, root.0.join("assets")).unwrap();
        assert!(save_bytes(&root.0, "paste", "png", b"x").is_err());
        assert_eq!(fs::read_dir(&other.0).unwrap().count(), 0);
    }
}
