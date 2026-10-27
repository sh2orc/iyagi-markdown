//! 문서 IO — 원문 보존 원칙(§4-2)의 Rust 쪽 반쪽.
//!
//! 원칙:
//! 1. 읽기: 바이트를 그대로 읽어 UTF-8로 디코드한다. BOM과 줄 끝 스타일(CRLF/LF)을
//!    **기록만** 하고, 편집기 버퍼에는 `\n`으로 정규화한 텍스트를 넘긴다
//!    (CodeMirror 6은 버퍼 줄바꿈으로 `\n`만 다룬다).
//! 2. 쓰기: 버퍼 텍스트에 기록해 둔 BOM·CRLF를 되살려 **임시 파일 → fsync → rename**의
//!    원자적 쓰기로 저장한다. 파싱 결과를 재직렬화하는 경로는 존재하지 않는다.
//! 3. 혼합 줄 끈(CRLF와 LF가 섞인) 파일: 순수 CRLF/LF 파일의 왕복은 바이트까지
//!    동일하다. 혼합 파일은 편집기가 줄 끝을 `\n`으로 정규화하는 특성상 지배적
//!    스타일로 저장된다 — 이 예외는 문서화된 유일한 손실 지점이고, 저장되지 않은
//!    채 닫히는 문서는 절대 다시 쓰이지 않으므로 원본은 그대로 남는다.
//!
//! 무결성 자동 검증(§4-2 5항) 중 (a) "열기→무수정→저장 시 바이트 동일"은
//! [`roundtrip_is_lossless`]가 순수 LF/CRLF/BOM 조합에 대해 보장한다.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex, MutexGuard,
};

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum DocError {
    #[error("파일을 읽을 수 없습니다: {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("파일이 UTF-8 텍스트가 아닙니다: {path} (바이너리이거나 다른 인코딩일 수 있습니다)")]
    NotUtf8 { path: PathBuf },
    #[error("파일을 쓸 수 없습니다: {path}: {source}")]
    Write {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("경로가 파일이 아닙니다: {path}")]
    NotAFile { path: PathBuf },
    #[error("저장 기준과 디스크 내용이 달라 저장하지 않았습니다: {path}")]
    Conflict { path: PathBuf, removed: bool },
}

/// 파일 감시 도착 여부와 관계없이 쓰기 직전에 확인하는 조건.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteExpectation {
    Match {
        text: String,
        meta: DocMeta,
    },
    Missing,
    /// 저장 대화상자에서 다른 대상 파일의 교체를 명시적으로 선택한 경우.
    Overwrite,
}

static DOCUMENT_WRITES: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 앱 안의 비교-쓰기와 이름 변경을 직렬화한다. 외부 편집기의 쓰기는 잠그지 못한다.
pub fn document_write_guard() -> MutexGuard<'static, ()> {
    DOCUMENT_WRITES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 문서의 원문 메타데이터 — 버퍼 텍스트와 함께 왕복하며 저장 시 되살려진다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocMeta {
    /// 원문이 UTF-8 BOM(EF BB BF)으로 시작했는가.
    pub had_bom: bool,
    /// 원문이 줄 바꿈에 CRLF를 썼는가(하나라도 `\r\n`이 있으면 true).
    pub crlf: bool,
}

/// 읽어 들인 문서: `\n` 정규화 텍스트 + 원문 메타데이터.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedDoc {
    pub text: String,
    pub meta: DocMeta,
    /// 파일의 수정 시각(초, UNIX epoch) — 외부 변경 감지의 기준선.
    pub mtime: f64,
    /// 파일 크기(바이트) — 충돌 안내 문구에 표시.
    pub size: u64,
}

pub const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// 문서를 읽는다. 바이트 → BOM 제거 → UTF-8 검증 → 줄 끝 정규화.
pub fn read_doc(path: &Path) -> Result<LoadedDoc, DocError> {
    let bytes = fs::read(path).map_err(|source| DocError::Read {
        path: path.to_path_buf(),
        source,
    })?;
    decode_doc(bytes, path)
}

/// 바이트 배열을 문서로 디코드한다(테스트와 [`read_doc`]이 공유하는 경로).
pub fn decode_doc(bytes: Vec<u8>, path: &Path) -> Result<LoadedDoc, DocError> {
    let (bytes, had_bom) = match bytes.strip_prefix(BOM) {
        Some(rest) => (rest, true),
        None => (bytes.as_slice(), false),
    };
    // 빈 파일·BOM만 있는 파일도 문서다.
    let mut text = String::from_utf8(bytes.to_vec()).map_err(|_| DocError::NotUtf8 {
        path: path.to_path_buf(),
    })?;
    let crlf = text.contains("\r\n");
    normalize_newlines(&mut text);
    let meta = fs::metadata(path).ok();
    Ok(LoadedDoc {
        text,
        meta: DocMeta { had_bom, crlf },
        mtime: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0),
        size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
    })
}

/// `\r\n`과 고아 `\r`을 `\n`으로 정규화한다(제자리에서, 할당 없이 가능한 만큼).
fn normalize_newlines(text: &mut String) {
    if !text.contains('\r') {
        return;
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    *text = out;
}

/// 버퍼 텍스트에 메타데이터를 되살려 저장용 바이트를 만든다.
pub fn encode_doc(text: &str, meta: DocMeta) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() + 3 + (text.matches('\n').count()));
    if meta.had_bom {
        out.extend_from_slice(BOM);
    }
    if meta.crlf {
        let mut iter = text.split('\n').peekable();
        while let Some(line) = iter.next() {
            out.extend_from_slice(line.as_bytes());
            if iter.peek().is_some() {
                out.extend_from_slice(b"\r\n");
            }
        }
    } else {
        out.extend_from_slice(text.as_bytes());
    }
    out
}

/// 원자적 저장: 같은 디렉터리의 임시 파일 → flush+fsync → rename.
/// rename(2)이 같은 볼륨에서 원자적이므로 저장 도중 충돌·정전이 있어도
/// 원본이 반쯤 덮여지는 일은 없다.
pub fn write_doc_atomic(path: &Path, text: &str, meta: DocMeta) -> Result<(), DocError> {
    let bytes = encode_doc(text, meta);
    write_bytes_atomic(path, &bytes)
}

pub fn write_doc_checked(
    path: &Path,
    text: &str,
    meta: DocMeta,
    expected: &WriteExpectation,
) -> Result<(), DocError> {
    let _guard = document_write_guard();
    if let WriteExpectation::Match { text, meta } = expected {
        match read_doc(path) {
            Ok(current) if current.text == *text && current.meta == *meta => {}
            Ok(_) => {
                return Err(DocError::Conflict {
                    path: path.into(),
                    removed: false,
                })
            }
            Err(DocError::Read { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
                return Err(DocError::Conflict {
                    path: path.into(),
                    removed: true,
                });
            }
            Err(error) => return Err(error),
        }
    }
    write_bytes_atomic_inner(
        path,
        &encode_doc(text, meta),
        !matches!(expected, WriteExpectation::Missing),
    )
}

/// 바이트를 원자적으로 기록한다(이미 완성된 출력물에도 쓴다 — 내보내기 등).
pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), DocError> {
    let _guard = document_write_guard();
    write_bytes_atomic_inner(path, bytes, true)
}

/// Install complete bytes only at a new path; never replace an existing asset.
pub fn write_bytes_new(path: &Path, bytes: &[u8]) -> Result<(), DocError> {
    let _guard = document_write_guard();
    write_bytes_atomic_inner(path, bytes, false)
}

fn write_bytes_atomic_inner(path: &Path, bytes: &[u8], replace: bool) -> Result<(), DocError> {
    write_file_atomic_inner(path, replace, false, true, |file| file.write_all(bytes))
}

/// Stream an export into a sibling temporary file; publish only after successful
/// completion and fsync. For document compare-and-save, use write_doc_checked.
/// The producer runs without the document-write lock; only publication takes it.
pub fn write_file_atomic(
    path: &Path,
    produce: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
) -> Result<(), DocError> {
    write_file_atomic_inner(path, true, true, true, produce)
}

/// Publish a complete stream at a new path in an existing directory. A competing
/// file is never replaced, and missing parent directories are never recreated.
pub fn write_file_new(
    path: &Path,
    produce: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
) -> Result<(), DocError> {
    write_file_atomic_inner(path, false, true, false, produce)
}

fn write_file_atomic_inner(
    path: &Path,
    replace: bool,
    lock_publication: bool,
    create_parents: bool,
    produce: impl FnOnce(&mut fs::File) -> std::io::Result<()>,
) -> Result<(), DocError> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    if create_parents {
        fs::create_dir_all(dir).map_err(|source| DocError::Write {
            path: dir.to_path_buf(),
            source,
        })?;
    }
    let write_err = |source: std::io::Error| DocError::Write {
        path: path.to_path_buf(),
        source,
    };
    // create_new는 이전 실행의 임시 파일/심볼릭 링크를 덮어쓰지 않는다.
    let (tmp, mut f) = loop {
        // Keep temporary names short even when the final filename is near the
        // filesystem's component-length limit.
        let tmp = dir.join(format!(
            ".iyagi-tmp-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
        {
            Ok(file) => break (tmp, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(write_err(error)),
        }
    };
    let result = (|| -> Result<(), DocError> {
        produce(&mut f).map_err(write_err)?;
        f.sync_all().map_err(write_err)?;
        drop(f);
        let _guard = lock_publication.then(document_write_guard);
        if replace {
            fs::rename(&tmp, path).map_err(write_err)?;
        } else {
            // 완성한 파일을 빈 경로에만 설치. exists()+rename()의 경합을 피한다.
            fs::hard_link(&tmp, path).map_err(|source| {
                if source.kind() == std::io::ErrorKind::AlreadyExists {
                    DocError::Conflict {
                        path: path.into(),
                        removed: false,
                    }
                } else {
                    write_err(source)
                }
            })?;
            let _ = fs::remove_file(&tmp);
        }
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    // 디렉터리 엔트리까지 굳히기(가능한 파일시스템에서만).
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// 열기→(무수정)→저장 왕복이 바이트까지 동일한가 — §4-2 5항 (a) 검증.
pub fn roundtrip_is_lossless(original: &[u8]) -> bool {
    let path = Path::new("corpus");
    let Ok(doc) = decode_doc(original.to_vec(), path) else {
        return false;
    };
    // 순수 LF/CRLF/BOM 조합은 무손실. 혼합 줄 끝은 정규화된다(문서화된 예외).
    let re = decode_doc(original.to_vec(), path)
        .map(|d| encode_doc(&d.text, d.meta))
        .unwrap_or_default();
    let _ = doc;
    original == re.as_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(bytes: &[u8]) -> Vec<u8> {
        let doc = decode_doc(bytes.to_vec(), Path::new("t.md")).unwrap();
        encode_doc(&doc.text, doc.meta)
    }

    #[test]
    fn lf_roundtrip_is_exact() {
        let src = "# 제목\n\n본문 *강조* `code`\n".as_bytes();
        assert_eq!(roundtrip(src), src);
        assert!(roundtrip_is_lossless(src));
    }

    #[test]
    fn crlf_roundtrip_is_exact() {
        let src = b"# Title\r\n\r\nline with \xea\xb0\x80 (UTF-8)\r\nlast\r\n".as_slice();
        assert_eq!(roundtrip(src), src);
        assert!(roundtrip_is_lossless(src));
    }

    #[test]
    fn bom_roundtrip_is_exact() {
        let src = b"\xEF\xBB\xBFBOM file\nsecond\n".as_slice();
        assert_eq!(roundtrip(src), src);
        assert!(roundtrip_is_lossless(src));
        let doc = decode_doc(src.to_vec(), Path::new("t")).unwrap();
        assert!(doc.meta.had_bom);
        assert!(!doc.text.starts_with('\u{FEFF}'));
    }

    #[test]
    fn bom_plus_crlf_roundtrip_is_exact() {
        let src = b"\xEF\xBB\xBFa\r\nb\r\n".as_slice();
        assert_eq!(roundtrip(src), src);
        assert!(roundtrip_is_lossless(src));
    }

    #[test]
    fn empty_and_bom_only_files() {
        assert_eq!(roundtrip(b""), b"");
        let bom_only: &[u8] = BOM;
        let doc = decode_doc(bom_only.to_vec(), Path::new("t")).unwrap();
        assert_eq!(doc.text, "");
        assert!(doc.meta.had_bom);
        assert_eq!(encode_doc(&doc.text, doc.meta), BOM);
    }

    #[test]
    fn no_final_newline_is_kept() {
        let src = b"no trailing newline".as_slice();
        assert_eq!(roundtrip(src), src);
        assert!(roundtrip_is_lossless(src));
    }

    #[test]
    fn cr_is_normalized_but_marked_crlf_only_with_crlf() {
        // 고아 \r(옛 Mac 스타일)은 \n으로 정규화된다 — crlf 플래그는 \r\n이 있을 때만.
        let doc = decode_doc(b"old\rmac\rstyle".to_vec(), Path::new("t")).unwrap();
        assert_eq!(doc.text, "old\nmac\nstyle");
        assert!(!doc.meta.crlf);
    }

    #[test]
    fn invalid_utf8_is_rejected_with_clear_error() {
        let err = decode_doc(vec![0xFF, 0xFE, b'a'], Path::new("t.md")).unwrap_err();
        assert!(matches!(err, DocError::NotUtf8 { .. }));
        assert!(err.to_string().contains("UTF-8"));
    }

    #[test]
    fn atomic_write_replaces_content_and_cleans_tmp() {
        let dir = std::env::temp_dir().join(format!("md-core-io-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.md");
        write_bytes_atomic(&path, b"first").unwrap();
        write_bytes_atomic(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("iyagi-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "임시 파일이 남았다: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn streaming_failure_keeps_previous_file_and_removes_partial_output() {
        let dir = std::env::temp_dir().join(format!("md-core-stream-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("book.epub");
        fs::write(&path, b"previous book").unwrap();
        let result = write_file_atomic(&path, |file| {
            file.write_all(b"partial zip")?;
            Err(std::io::Error::other("injected producer failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"previous book");
        let entries: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("book.epub")]);
        // The producer may seek (ZIP central-directory generation) and does not
        // hold the document lock during potentially expensive export work.
        write_file_atomic(&path, |file| {
            use std::io::{Seek, SeekFrom};
            let _guard = document_write_guard();
            file.write_all(b"zip000")?;
            file.seek(SeekFrom::Start(3))?;
            file.write_all(b"END")
        })
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"zipEND");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn new_stream_publishes_only_complete_output_and_preserves_a_competing_file() {
        let dir = std::env::temp_dir().join(format!("md-core-new-stream-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("copy.md");
        let result = write_file_new(&path, |file| {
            file.write_all(b"partial")?;
            assert!(!path.exists());
            Err(std::io::Error::other("injected copy failure"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        // Only publication collisions are retryable, not producer errors.
        let result = write_file_new(&path, |_| Err(std::io::ErrorKind::AlreadyExists.into()));
        assert!(matches!(result, Err(DocError::Write { .. })));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        let result = write_file_new(&path, |file| {
            file.write_all(b"our copy")?;
            assert!(!path.exists());
            fs::write(&path, b"competing writer")
        });
        assert!(matches!(result, Err(DocError::Conflict { .. })));
        assert_eq!(fs::read(&path).unwrap(), b"competing writer");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_file(&path).unwrap();
        write_file_new(&path, |file| {
            file.write_all(b"complete")?;
            assert!(!path.exists());
            Ok(())
        })
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"complete");
        let missing = dir.join("deleted-folder");
        assert!(
            write_file_new(&missing.join("new.md"), |_| panic!("producer must not run")).is_err()
        );
        assert!(!missing.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn new_stream_supports_long_valid_document_names() {
        let dir = std::env::temp_dir().join(format!("md-core-long-stream-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join(format!("{}.md", "a".repeat(240)));
        write_file_new(&path, |file| file.write_all(b"complete")).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"complete");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn checked_writers_cannot_both_replace_the_same_baseline() {
        let dir = std::env::temp_dir().join(format!("md-core-cas-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("shared.md");
        let meta = DocMeta {
            had_bom: false,
            crlf: false,
        };
        write_doc_atomic(&path, "baseline", meta).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = ["first window", "second window"]
            .into_iter()
            .map(|text| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    write_doc_checked(
                        &path,
                        text,
                        meta,
                        &WriteExpectation::Match {
                            text: "baseline".into(),
                            meta,
                        },
                    )
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(DocError::Conflict { removed: false, .. })))
                .count(),
            1
        );
        let final_text = fs::read_to_string(&path).unwrap();
        assert!(["first window", "second window"].contains(&final_text.as_str()));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_and_changed_encoding_require_confirmation() {
        let dir = std::env::temp_dir().join(format!("md-core-conditions-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("document.md");
        let meta = DocMeta {
            had_bom: false,
            crlf: false,
        };
        write_doc_atomic(&path, "existing", meta).unwrap();
        assert!(matches!(
            write_doc_checked(&path, "", meta, &WriteExpectation::Missing),
            Err(DocError::Conflict { removed: false, .. })
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), "existing");
        let expected = WriteExpectation::Match {
            text: "existing".into(),
            meta,
        };
        let bom_meta = DocMeta {
            had_bom: true,
            crlf: false,
        };
        write_doc_atomic(&path, "existing", bom_meta).unwrap();
        assert!(matches!(
            write_doc_checked(&path, "changed", meta, &expected),
            Err(DocError::Conflict { removed: false, .. })
        ));
        fs::remove_file(&path).unwrap();
        assert!(matches!(
            write_doc_checked(&path, "changed", meta, &expected),
            Err(DocError::Conflict { removed: true, .. })
        ));
        write_doc_checked(&path, "recreated", meta, &WriteExpectation::Missing).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "recreated");
        let _ = fs::remove_dir_all(dir);
    }
}
