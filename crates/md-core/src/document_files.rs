//! Create and duplicate documents without exposing partially copied files.
use crate::{
    i18n::{Lang, Msg},
    io::{write_file_new, DocError},
    tree::is_markdown_name,
};
use std::{
    fs,
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const MAX_CANDIDATES: u32 = 10_000;

fn write_error(path: &Path, source: io::Error) -> DocError {
    DocError::Write {
        path: path.into(),
        source,
    }
}

fn existing_directory(dir: &Path) -> Result<(), DocError> {
    if !dir.is_absolute() || dir.to_str().is_none() {
        return Err(write_error(
            dir,
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "Choose an absolute folder with a supported path encoding",
            ),
        ));
    }
    let metadata = fs::metadata(dir).map_err(|error| write_error(dir, error))?;
    if !metadata.is_dir() {
        return Err(write_error(
            dir,
            io::Error::new(
                io::ErrorKind::NotADirectory,
                "The destination is not a folder",
            ),
        ));
    }
    Ok(())
}

fn publish_unique(
    dir: &Path,
    stem: &str,
    extension: &str,
    first: u32,
    mut produce: impl FnMut(&mut fs::File) -> io::Result<()>,
) -> Result<PathBuf, DocError> {
    for ordinal in first..first + MAX_CANDIDATES {
        let name = if ordinal == 1 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} {ordinal}.{extension}")
        };
        let path = dir.join(name);
        // Skip known collisions without copying the source again. Publication
        // still checks atomically: this lookup is only an IO optimization.
        match fs::symlink_metadata(&path) {
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(write_error(&path, error)),
        }
        match write_file_new(&path, &mut produce) {
            Ok(()) => return Ok(path),
            Err(DocError::Conflict { .. }) => continue,
            Err(error) => return Err(error),
        }
    }
    Err(write_error(
        dir,
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "No available document name; rename existing copies or choose another folder",
        ),
    ))
}

pub fn create_document(dir: &Path, language: Lang) -> Result<PathBuf, DocError> {
    existing_directory(dir)?;
    publish_unique(dir, Msg::Untitled.text(language), "md", 1, |_| Ok(()))
}

fn same_source(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    let same = after.is_file()
        && before.len() == after.len()
        && before.modified().ok() == after.modified().ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        same && before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        same
    }
}

pub fn duplicate_document(path: &Path) -> Result<PathBuf, DocError> {
    let read_error = |source| DocError::Read {
        path: path.into(),
        source,
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| is_markdown_name(name))
        .ok_or_else(|| {
            read_error(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Choose a Markdown document",
            ))
        })?;
    let dir = path
        .parent()
        .ok_or_else(|| read_error(io::Error::other("The source folder is missing")))?;
    existing_directory(dir)?;
    let before = fs::symlink_metadata(path).map_err(read_error)?;
    if !before.is_file() {
        return Err(DocError::NotAFile { path: path.into() });
    }
    // Open the source before allocating a destination. Copies use this handle,
    // so an atomic replacement of the source cannot mix two document versions.
    let mut input = fs::File::open(path).map_err(read_error)?;
    let snapshot = input.metadata().map_err(read_error)?;
    if !same_source(&before, &snapshot) {
        return Err(read_error(io::Error::other(
            "The source changed before copying; try again",
        )));
    }
    let (stem, extension) = name
        .rsplit_once('.')
        .expect("Markdown names have an extension");
    publish_unique(dir, stem, extension, 2, |output| {
        input.seek(SeekFrom::Start(0))?;
        if !same_source(&snapshot, &input.metadata()?) {
            return Err(io::Error::other(
                "The source changed while copying; try again",
            ));
        }
        // Bound reads even if another process keeps appending to the source.
        let copied = io::copy(
            &mut (&mut input).take(snapshot.len().saturating_add(1)),
            output,
        )?;
        if copied != snapshot.len() || !same_source(&snapshot, &input.metadata()?) {
            return Err(io::Error::other(
                "The source changed while copying; try again",
            ));
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        sync::{
            atomic::{AtomicU64, Ordering},
            Arc, Barrier,
        },
    };

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "iyagi-document-files-{}-{}",
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn localized_names_skip_existing_files_and_folders() {
        let dir = TestDir::new();
        fs::write(dir.0.join("Untitled.md"), b"keep me").unwrap();
        fs::create_dir(dir.0.join("Untitled 2.md")).unwrap();
        assert_eq!(
            create_document(&dir.0, Lang::En).unwrap(),
            dir.0.join("Untitled 3.md")
        );
        assert_eq!(
            create_document(&dir.0, Lang::Ko).unwrap(),
            dir.0.join("제목 없음.md")
        );
        assert_eq!(
            create_document(&dir.0, Lang::Ko).unwrap(),
            dir.0.join("제목 없음 2.md")
        );
        assert_eq!(fs::read(dir.0.join("Untitled.md")).unwrap(), b"keep me");
        assert!(dir.0.join("Untitled 2.md").is_dir());
        assert!(fs::read(dir.0.join("제목 없음.md")).unwrap().is_empty());
    }

    #[test]
    fn duplicates_preserve_bytes_and_extension_without_overwriting() {
        let dir = TestDir::new();
        let source = dir.0.join("회의.MARKDOWN");
        let bytes = b"\xef\xbb\xbf# title\r\nfirst\nlast\r";
        fs::write(&source, bytes).unwrap();
        fs::write(dir.0.join("회의 2.MARKDOWN"), b"existing copy").unwrap();
        let copy = duplicate_document(&source).unwrap();
        assert_eq!(copy, dir.0.join("회의 3.MARKDOWN"));
        assert_eq!(fs::read(&copy).unwrap(), bytes);
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(
            fs::read(dir.0.join("회의 2.MARKDOWN")).unwrap(),
            b"existing copy"
        );
    }

    #[test]
    fn invalid_sources_and_missing_folders_leave_no_output() {
        let dir = TestDir::new();
        fs::write(dir.0.join("image.png"), b"image").unwrap();
        fs::create_dir(dir.0.join("folder.md")).unwrap();
        for name in ["missing.md", "image.png", "folder.md"] {
            assert!(duplicate_document(&dir.0.join(name)).is_err());
        }
        assert!(create_document(&dir.0.join("missing"), Lang::En).is_err());
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_preserved_and_not_copied_as_documents() {
        use std::os::unix::fs::symlink;
        let dir = TestDir::new();
        let missing = dir.0.join("missing.md");
        let link = dir.0.join("Untitled.md");
        symlink(&missing, &link).unwrap();
        assert_eq!(
            create_document(&dir.0, Lang::En).unwrap(),
            dir.0.join("Untitled 2.md")
        );
        assert_eq!(fs::read_link(&link).unwrap(), missing);
        assert!(duplicate_document(&link).is_err());
        let source = dir.0.join("source.md");
        fs::write(&source, b"original").unwrap();
        symlink(&source, dir.0.join("linked.md")).unwrap();
        assert!(duplicate_document(&dir.0.join("linked.md")).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"original");
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 4);
    }

    #[test]
    fn racing_duplicate_requests_publish_distinct_complete_files() {
        let dir = TestDir::new();
        let source = dir.0.join("shared.md");
        let bytes = vec![b'x'; 65_537];
        fs::write(&source, &bytes).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let source = source.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    duplicate_document(&source).unwrap()
                })
            })
            .collect();
        let copies: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_ne!(copies[0], copies[1]);
        for path in copies {
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
        assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 3);
    }

    #[test]
    fn known_collisions_do_not_run_the_copy_producer() {
        let dir = TestDir::new();
        fs::write(dir.0.join("large 2.md"), b"existing").unwrap();
        fs::create_dir(dir.0.join("large 3.md")).unwrap();
        let mut calls = 0;
        let path = publish_unique(&dir.0, "large", "md", 2, |output| {
            calls += 1;
            output.write_all(b"complete")
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(path, dir.0.join("large 4.md"));
        assert_eq!(fs::read(path).unwrap(), b"complete");
    }
}
