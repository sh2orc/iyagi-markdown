//! IYAGI Markdown 내보내기 크레이트 — DOCX(comrak AST → 직접 OOXML 작성)와
//! SVG→DrawingML·MathML→OMML 변환기(§4-3: 래스터화 금지, 편집 가능 객체 유지).

pub mod citations;
pub mod docx;
mod docx_comments;
mod docx_lists;
pub mod epub;
pub mod mathml2omml;
pub mod svg2dml;
pub mod xml;

use std::path::PathBuf;

/// 문서 기준 상대 경로에서 이미지 바이너리를 읽어 주는 소스.
pub struct ImageSource {
    pub base_dir: PathBuf,
    /// 문서별 이미지 폭(%) — 마크다운 src 키(사이드카). 내보내기 축소용.
    widths: std::collections::HashMap<String, u32>,
}

impl ImageSource {
    pub fn new(base_dir: String) -> Self {
        Self {
            base_dir: PathBuf::from(base_dir),
            widths: std::collections::HashMap::new(),
        }
    }

    /// 사이드카 이미지 폭 등록(마크다운 src → 퍼센트).
    pub fn set_widths(&mut self, widths: std::collections::HashMap<String, u32>) {
        self.widths = widths;
    }

    /// 해당 src의 지정 폭(%) — 없으면 None(100%).
    pub fn width(&self, url: &str) -> Option<u32> {
        self.widths.get(url).copied()
    }

    /// 경로(절대 또는 base_dir 상대)를 어휘적으로 정규화한 절대경로.
    /// "a.png"와 "./a.png"·"sub/../a.png"가 같은 파일로 모이는 기준.
    pub fn resolve(&self, path: &str) -> PathBuf {
        let p = PathBuf::from(path);
        if p.is_absolute() {
            lexical_clean(&p)
        } else {
            lexical_clean(&self.base_dir.join(path.replace('\\', "/")))
        }
    }

    /// Markdown image URL → local path. Decode exactly once, after separating
    /// query/fragment so encoded `%23` and `%3F` remain filename characters.
    /// Remote, data, file and other schemes are not local filesystem paths.
    pub fn resolve_url(&self, url: &str) -> Option<PathBuf> {
        let url = url.trim();
        if url.starts_with("//") {
            return None;
        }
        let path = url.split(['?', '#']).next()?;
        if path.is_empty() {
            return None;
        }
        match md_core::links::resolve(path, &self.base_dir) {
            md_core::links::LinkTarget::Asset { path }
            | md_core::links::LinkTarget::Markdown { path, .. } => Some(path),
            _ => None,
        }
    }

    /// 로컬 이미지 URL의 바이트. 미지원 URL·읽기 실패는 None.
    pub fn read(&self, url: &str) -> Option<Vec<u8>> {
        std::fs::read(self.resolve_url(url)?).ok()
    }
}

fn lexical_clean(path: &std::path::Path) -> PathBuf {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_urls_decode_once_and_ignore_nonlocal_targets() {
        let source = ImageSource::new("/workspace/docs".into());
        for (url, expected) in [
            (
                "./assets/a%20b.png?v=2#preview",
                "/workspace/docs/assets/a b.png",
            ),
            ("../a%23b%3Fc%2520.SVG#shape", "/workspace/a#b?c%20.SVG"),
            ("/shared/%ED%95%9C%EA%B8%80.png", "/shared/한글.png"),
            (
                " assets\\drawing.svg?version=1 ",
                "/workspace/docs/assets/drawing.svg",
            ),
            ("a%zz.png", "/workspace/docs/a%zz.png"),
        ] {
            assert_eq!(
                source.resolve_url(url),
                Some(PathBuf::from(expected)),
                "{url}"
            );
        }
        for url in [
            "",
            "  ",
            "#preview",
            "?download=1",
            "//server/image.png",
            "https://server/image.png",
            "HTTP://server/image.png",
            "data:image/png;base64,abc",
            "file:///shared/image.png",
            "custom+image:picture.png",
        ] {
            assert_eq!(source.resolve_url(url), None, "{url}");
        }
        // Raw filesystem paths (used after EPUB URL decoding) keep literal '%'.
        assert_eq!(
            source.resolve("assets/a%20b.png"),
            PathBuf::from("/workspace/docs/assets/a%20b.png")
        );
    }
}
