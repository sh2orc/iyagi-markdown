//! 링크·경로 해석. 프런트의 `src/links.ts`와 같은 규칙을 공유하며,
//! 상대 경로 해석·분류·슬러그 규칙은 테스트 코퍼스로 서로 일치하는지 검증한다.

use std::path::{Path, PathBuf};

/// 해석된 링크의 종류. 어떤 동작을 해야 하는지는 이 분류가 결정한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    /// http(s) 등 외부 URL — 기본 브라우저로.
    External(String),
    /// mailto: — 메일 클라이언트로.
    Mail(String),
    /// 같은 문서 안의 앵커(`#heading`) — TOC/스크롤 이동.
    Anchor(String),
    /// 다른 마크다운 문서(상대 경로) — 앱 내 새 탭. anchor가 붙을 수 있다.
    Markdown {
        path: PathBuf,
        anchor: Option<String>,
    },
    /// 문서 폴더 기준 상대 이미지·자원. 원격 이미지 정책은 프런트 설정이 결정.
    Asset { path: PathBuf },
    /// 그 밖의 스킴(file:, custom:) — 기본 앱/브라우저로 넘긴다.
    Other(String),
}

/// 마크다운 링크 대상 URL을 문서 위치 기준으로 해석한다.
///
/// - `http:`, `https:`, `ftp:` → External
/// - `mailto:` → Mail
/// - `#slug` → Anchor
/// - 절대 URL이 아닌 경로는 `base_dir`에 붙여 정규화. `.md`/`.markdown`이면
///   Markdown, 이미지 확장자면 Asset, 나머지는 Asset으로 분류해 프런트가
///   이미지 여부를 문맥(링크 vs 이미지)으로 결정하게 한다.
pub fn resolve(link: &str, base_dir: &Path) -> LinkTarget {
    let link = link.trim();
    let lower = link.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("ftp://")
    {
        return LinkTarget::External(link.to_string());
    }
    if lower.starts_with("mailto:") {
        return LinkTarget::Mail(link.to_string());
    }
    if let Some(rest) = link.strip_prefix('#') {
        return LinkTarget::Anchor(percent_decode(rest));
    }
    if link.contains("://") || lower.starts_with("data:") {
        return LinkTarget::Other(link.to_string());
    }
    // 상대 경로: 앵커 부분을 분리하고 percent-decode한 뒤 base_dir에 결합.
    let (file_part, anchor) = match link.split_once('#') {
        Some((f, a)) => (f, Some(percent_decode(a))),
        None => (link, None),
    };
    if file_part.is_empty() {
        return LinkTarget::Anchor(anchor.unwrap_or_default());
    }
    let decoded = percent_decode(file_part);
    // URL 스타일 경로 구분자를 통일(Windows 경로가 아니므로 '/'만 다룬다).
    let joined = base_dir.join(decoded.replace('\\', "/"));
    let normalized = lexically_clean(&joined);
    let lower_ext = normalized
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match lower_ext.as_str() {
        "md" | "markdown" | "mdown" | "mkd" => LinkTarget::Markdown {
            path: normalized,
            anchor,
        },
        _ => LinkTarget::Asset { path: normalized },
    }
}

/// `.`/`..`를 어휘적으로 정리한다(파일시스템에 접근하지 않는다 — 문서 기준
/// 상대 경로는 대부분 존재하는 경로를 가리키고, 없으면 열기 단계에서 실패한다).
fn lexically_clean(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// percent-encoding 복호(`%20` 등). 잘못된 이스케이프는 그대로 둔다.
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// GitHub 방식 제목 슬러그: 소문자화, 특수문자 제거, 공백→`-`.
/// 프런트의 `slugifyHeading`과 규칙이 같아야 한다(앵커 이동 정확성).
/// 중복 슬러그 판별(`-1` 접미)은 프런트가 오프셋 목록으로 처리한다.
pub fn slug_heading(text: &str) -> String {
    let mut slug = String::with_capacity(text.len());
    for c in text.trim().chars() {
        if c.is_alphanumeric() {
            for lc in c.to_lowercase() {
                slug.push(lc);
            }
        } else if c.is_whitespace() && !slug.ends_with('-') {
            slug.push('-');
        }
        // 그 외 문장부호는 제거.
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "section".to_string()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> PathBuf {
        Path::new("/Users/x/docs").to_path_buf()
    }

    #[test]
    fn external_and_mail() {
        assert_eq!(
            resolve("https://example.com/a?b=1", &base()),
            LinkTarget::External("https://example.com/a?b=1".into())
        );
        assert!(matches!(
            resolve("mailto:a@b.c", &base()),
            LinkTarget::Mail(_)
        ));
    }

    #[test]
    fn anchor_only() {
        assert_eq!(resolve("#개요", &base()), LinkTarget::Anchor("개요".into()));
        assert_eq!(
            resolve("#section-2", &base()),
            LinkTarget::Anchor("section-2".into())
        );
    }

    #[test]
    fn relative_markdown_link() {
        assert_eq!(
            resolve("notes/today.md", &base()),
            LinkTarget::Markdown {
                path: PathBuf::from("/Users/x/docs/notes/today.md"),
                anchor: None
            }
        );
        assert_eq!(
            resolve("./up/../a.md#head", &base()),
            LinkTarget::Markdown {
                path: PathBuf::from("/Users/x/docs/a.md"),
                anchor: Some("head".into())
            }
        );
        assert_eq!(
            resolve("b.MARKDOWN", &base()),
            LinkTarget::Markdown {
                path: PathBuf::from("/Users/x/docs/b.MARKDOWN"),
                anchor: None
            }
        );
    }

    #[test]
    fn percent_encoded_paths() {
        assert_eq!(
            resolve("my%20file.md", &base()),
            LinkTarget::Markdown {
                path: PathBuf::from("/Users/x/docs/my file.md"),
                anchor: None
            }
        );
        assert_eq!(
            resolve("img/_%EC%82%AC%EC%A7%84.png", &base()),
            LinkTarget::Asset {
                path: PathBuf::from("/Users/x/docs/img/_사진.png")
            }
        );
    }

    #[test]
    fn assets_and_other_schemes() {
        assert_eq!(
            resolve("media/diagram.svg", &base()),
            LinkTarget::Asset {
                path: PathBuf::from("/Users/x/docs/media/diagram.svg")
            }
        );
        assert!(matches!(
            resolve("file:///tmp/a.md", &base()),
            LinkTarget::Other(_)
        ));
    }

    #[test]
    fn slug_matches_github_rules() {
        assert_eq!(slug_heading("Hello, World!"), "hello-world");
        assert_eq!(slug_heading("한글 제목 이해"), "한글-제목-이해");
        assert_eq!(slug_heading("C++ & Rust"), "c-rust");
        assert_eq!(slug_heading("  ---  "), "section");
        assert_eq!(slug_heading("Multiple   Spaces"), "multiple-spaces");
    }
}
