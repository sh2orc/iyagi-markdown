//! IYAGI Markdown 내보내기 크레이트 — DOCX(comrak AST → 직접 OOXML 작성)와
//! SVG→DrawingML·MathML→OMML 변환기(§4-3: 래스터화 금지, 편집 가능 객체 유지).

pub mod docx;
pub mod mathml2omml;
pub mod svg2dml;
pub mod xml;

use std::path::PathBuf;

/// 문서 기준 상대 경로에서 이미지 바이너리를 읽어 주는 소스.
pub struct ImageSource {
    pub base_dir: PathBuf,
}

impl ImageSource {
    pub fn new(base_dir: String) -> Self {
        Self {
            base_dir: PathBuf::from(base_dir),
        }
    }

    /// 경로(절대 또는 base_dir 상대)의 바이트. 없으면 None.
    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        let p = PathBuf::from(path);
        let p = if p.is_absolute() {
            p
        } else {
            let joined = self.base_dir.join(path.replace('\\', "/"));
            lexical_clean(&joined)
        };
        std::fs::read(p).ok()
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
