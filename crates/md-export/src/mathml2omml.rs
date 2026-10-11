//! MathML(Presentation 부분집합) → OMML 변환기(§4-3). KaTeX output:'mathml' 결과를
//! Word 수식(m:oMath)으로 옮긴다. (Phase 5에서 완전 구현 — 현재는 자리만 둔다.)

#[derive(Debug, thiserror::Error)]
pub enum MathError {
    #[error("MathML을 해석하지 못했습니다: {0}")]
    Parse(String),
}

/// MathML 문자열 → m:oMath XML 조각.
pub fn mathml_to_omml(mathml: &str) -> Result<String, MathError> {
    let _ = mathml;
    Err(MathError::Parse("아직 구현 전".into()))
}
