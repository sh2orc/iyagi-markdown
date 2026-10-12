//! IYAGI Markdown 내보내기 크레이트 — DOCX(comrak AST → 직접 OOXML 작성)와
//! SVG→DrawingML·MathML→OMML 변환기(§4-3: 래스터화 금지, 편집 가능 객체 유지).

pub mod docx;
pub mod epub;
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

    /// 경로(절대 또는 base_dir 상대)의 바이트. 없으면 None.
    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        std::fs::read(self.resolve(path)).ok()
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
