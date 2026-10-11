//! SVG → DrawingML 변환기(§4-3). usvg로 파싱·정규화한 뒤 wps/wpg XML로 떨어뜨린다.
//! (Phase 5에서 완전 구현 — 현재는 자리만 둔다.)

#[derive(Debug, thiserror::Error)]
pub enum SvgError {
    #[error("SVG를 해석하지 못했습니다: {0}")]
    Parse(String),
}

/// SVG 문자열 → 인라인 DrawingML(w:drawing … wpg:wgp) XML 조각.
pub fn svg_to_drawingml(svg: &str, _max_width_emu: i64) -> Result<String, SvgError> {
    let _ = svg;
    Err(SvgError::Parse("아직 구현 전".into()))
}
