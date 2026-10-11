//! 마크다운 → DOCX. comrak으로 AST를 만들어 OOXML을 직접 작성한다(§4-4).
//! (Phase 5에서 완전 구현 — 현재는 자리만 둔다.)

use std::collections::HashMap;
use std::path::Path;

use crate::ImageSource;

#[derive(Debug, thiserror::Error)]
pub enum DocxError {
    #[error("DOCX 생성 실패: {0}")]
    Build(String),
    #[error("파일 쓰기 실패: {0}")]
    Io(#[from] std::io::Error),
}

pub fn export_docx(
    markdown: &str,
    math: &HashMap<String, String>,
    diagrams: &HashMap<String, String>,
    images: &ImageSource,
    out: &Path,
) -> Result<(), DocxError> {
    let _ = (markdown, math, diagrams, images, out);
    Err(DocxError::Build("아직 구현 전".into()))
}
