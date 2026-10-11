//! SVG → DrawingML 변환기(§4-3).
//!
//! mermaid 출력은 SVG 기본 요소의 조합이고 DrawingML은 임의 경로를 custGeom으로
//! 표현할 수 있으므로, **다이어그램 종류와 무관한 범용 변환**이 된다. 결과는
//! Word에서 도형 그룹으로 선택·이동·텍스트 편집이 가능하다. 래스터 폴백은 없다.
//!
//! 변환 규칙(§4-3 표):
//! - rect/circle/ellipse/line/polygon은 usvg가 이미 path로 정규화한다 — 전부 custGeom.
//! - `g` → wpg:grpSp, path → wps:wsp(custGeom), text → 텍스트 상자(wps:txbx).
//! - 그라디언트·필터는 단색으로 단순화하되 도형은 유지.
//! - 화살표 머리(marker)는 usvg가 버리므로, 마커를 쓰는 SVG에서 열린 선분 경로에
//!   선 끝 장식(a:tailEnd)으로 살린다.
//!
//! 좌표: SVG px(좌상단 원점) → DrawingML은 좌상단 원점 EMU(1px@96dpi = 9525EMU).
//! 그룹의 chExt를 원본 좌표계로 두고 자식을 그 안에 배치한 뒤, 전체 그룹의
//! ext를 페이지 폭에 맞춘다(비율 유지).

use std::fmt::Write as _;

use crate::xml::esc;

#[derive(Debug, thiserror::Error)]
pub enum SvgError {
    #[error("SVG를 해석하지 못했습니다: {0}")]
    Parse(String),
    #[error("빈 SVG입니다")]
    Empty,
}

const EMU_PER_PX: f64 = 9525.0;

/// 시스템 폰트가 로드된 usvg 옵션 — 한 번만 로드한다(텍스트 해석에 필요).
fn svg_options() -> usvg::Options<'static> {
    use std::sync::OnceLock;
    static DB: OnceLock<std::sync::Arc<usvg::fontdb::Database>> = OnceLock::new();
    let db = DB.get_or_init(|| {
        let mut db = usvg::fontdb::Database::new();
        db.load_system_fonts();
        std::sync::Arc::new(db)
    });
    usvg::Options {
        fontdb: db.clone(),
        ..Default::default()
    }
}

/// SVG 문자열 → 인라인 DrawingML(w:drawing … wpg:wgp) XML 조각.
/// `max_width_emu`에 맞춰 축소(확대는 하지 않는다).
pub fn svg_to_drawingml(svg: &str, max_width_emu: i64) -> Result<String, SvgError> {
    let uses_markers = svg.contains("marker-end=") || svg.contains("marker-start=");
    let tree =
        usvg::Tree::from_str(svg, &svg_options()).map_err(|e| SvgError::Parse(e.to_string()))?;
    let size = tree.size();
    let (w, h) = (size.width() as f64, size.height() as f64);
    if w <= 0.0 || h <= 0.0 {
        return Err(SvgError::Empty);
    }

    // 전체 스케일: 페이지 폭 초과 시 축소.
    let scale = (max_width_emu as f64 / (w * EMU_PER_PX)).min(1.0);
    let total_w = (w * EMU_PER_PX * scale).round() as i64;
    let total_h = (h * EMU_PER_PX * scale).round() as i64;

    let mut children = String::new();
    walk_group(tree.root(), &mut children, uses_markers);

    // chExt는 원본 SVG 좌표계(px)를 그대로 쓴다 — 자식 offset과 같은 공간.
    let ch_w = (w * EMU_PER_PX).round() as i64;
    let ch_h = (h * EMU_PER_PX).round() as i64;
    Ok(format!(
        concat!(
            "<w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">",
            "<wp:extent cx=\"{total_w}\" cy=\"{total_h}\"/>",
            "<wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>",
            "<wp:docPr id=\"{doc_id}\" name=\"Diagram\"/>",
            "<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>",
            "<a:graphic><a:graphicData uri=\"http://schemas.microsoft.com/office/word/2010/wordprocessingGroup\">",
            "<wpg:wgp><wpg:cNvGrpSpPr/><wpg:grpSpPr>",
            "<a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{total_w}\" cy=\"{total_h}\"/>",
            "<a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"{ch_w}\" cy=\"{ch_h}\"/></a:xfrm>",
            "</wpg:grpSpPr>{children}</wpg:wgp>",
            "</a:graphicData></a:graphic></wp:inline></w:drawing>",
        ),
        total_w = total_w,
        total_h = total_h,
        ch_w = ch_w,
        ch_h = ch_h,
        doc_id = next_doc_id(),
        children = children,
    ))
}

/// 그림마다 고유 id — 정적 카운터(프로세스당).
fn next_doc_id() -> i64 {
    use std::sync::atomic::{AtomicI64, Ordering};
    static SEQ: AtomicI64 = AtomicI64::new(1000);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

fn walk_group(group: &usvg::Group, out: &mut String, uses_markers: bool) {
    for node in group.children() {
        match node {
            usvg::Node::Group(g) => {
                // 중첩 그룹 — 그대로 펼쳐 자식 좌표는 abs_transform이 이미 풀고 있다.
                walk_group(g, out, uses_markers);
            }
            usvg::Node::Path(p) => {
                out.push_str(&path_to_shape(p, &node.abs_transform(), uses_markers));
            }
            usvg::Node::Text(t) => {
                out.push_str(&text_to_shape(t, &node.abs_transform()));
            }
            usvg::Node::Image(_) => {
                // SVG 안의 비트맵 — 래스터 경로는 만들지 않는다(§4-3): 자리 상자만.
            }
        }
    }
}

/// usvg Transform를 점에 적용(SVG 행렬 순서 [a c e / b d f]).
fn apply(t: &usvg::Transform, x: f32, y: f32) -> (f64, f64) {
    (
        (t.sx * x + t.kx * y + t.tx) as f64,
        (t.ky * x + t.sy * y + t.ty) as f64,
    )
}

struct BBox {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

impl BBox {
    fn add(&mut self, x: f64, y: f64) {
        self.min_x = self.min_x.min(x);
        self.min_y = self.min_y.min(y);
        self.max_x = self.max_x.max(x);
        self.max_y = self.max_y.max(y);
    }
    fn width(&self) -> f64 {
        self.max_x - self.min_x
    }
    fn height(&self) -> f64 {
        self.max_y - self.min_y
    }
}

struct Geom {
    /// custGeom pathLst XML(좌표는 bbox 기준 0,0).
    xml: String,
    closed: bool,
    bbox: BBox,
}

/// tiny-skia 경로 → custGeom. 점에 transform를 적용하고 bbox로 리베이스한다.
fn convert_path(data: &tiny_skia_path::Path, t: &usvg::Transform) -> Geom {
    let verbs = data.verbs();
    let points = data.points();
    let mut pi = 0usize;
    let mut bbox = BBox {
        min_x: f64::MAX,
        min_y: f64::MAX,
        max_x: f64::MIN,
        max_y: f64::MIN,
    };
    let mut closed = false;

    // 1차: 변환된 점 수집.
    let mut tp: Vec<(f64, f64)> = Vec::with_capacity(points.len());
    for p in points {
        let (x, y) = apply(t, p.x, p.y);
        bbox.add(x, y);
        tp.push((x, y));
    }
    // 2차: verb별 XML.
    let mut xml = String::new();
    let mut cursor: Option<(f64, f64)> = None;
    for v in verbs {
        match v {
            tiny_skia_path::PathVerb::Move => {
                let (x, y) = tp[pi];
                pi += 1;
                let _ = writeln!(xml, r#"<a:moveTo><a:pt x="{}" y="{}"/></a:moveTo>"#, x, y);
                cursor = Some((x, y));
            }
            tiny_skia_path::PathVerb::Line => {
                let (x, y) = tp[pi];
                pi += 1;
                let _ = writeln!(xml, r#"<a:lnTo><a:pt x="{}" y="{}"/></a:lnTo>"#, x, y);
            }
            tiny_skia_path::PathVerb::Quad => {
                let (cx, cy) = tp[pi];
                let (x, y) = tp[pi + 1];
                pi += 2;
                let _ = writeln!(
                    xml,
                    r#"<a:quadBezTo><a:pt x="{}" y="{}"/><a:pt x="{}" y="{}"/></a:quadBezTo>"#,
                    cx, cy, x, y
                );
            }
            tiny_skia_path::PathVerb::Cubic => {
                let (c1x, c1y) = tp[pi];
                let (c2x, c2y) = tp[pi + 1];
                let (x, y) = tp[pi + 2];
                pi += 3;
                let _ = writeln!(
                    xml,
                    r#"<a:cubicBezTo><a:pt x="{}" y="{}"/><a:pt x="{}" y="{}"/><a:pt x="{}" y="{}"/></a:cubicBezTo>"#,
                    c1x, c1y, c2x, c2y, x, y
                );
            }
            tiny_skia_path::PathVerb::Close => {
                closed = true;
                xml.push_str("<a:close/>");
                if let Some(c) = cursor {
                    let _ = writeln!(
                        xml,
                        r#"<a:moveTo><a:pt x="{}" y="{}"/></a:moveTo>"#,
                        c.0, c.1
                    );
                }
            }
        }
    }
    // 3차: bbox 리베이스(정수 픽셀 좌표로 반올림해 잔물결을 없앤다).
    let xml = rebase(&xml, &bbox);
    Geom { xml, closed, bbox }
}

/// 절대 좌표 XML을 bbox 기준 상대 좌표로 다시 쓴다(EMU).
fn rebase(xml: &str, bbox: &BBox) -> String {
    let mut out = String::with_capacity(xml.len());
    // a:pt 태그만 골라 좌표를 바꾼다.
    let mut rest = xml;
    while let Some(start) = rest.find("<a:pt ") {
        let end = rest[start..]
            .find("/>")
            .map(|i| start + i + 2)
            .unwrap_or(rest.len());
        let tag = &rest[start..end];
        let x: f64 = attr(tag, "x").parse().unwrap_or(0.0);
        let y: f64 = attr(tag, "y").parse().unwrap_or(0.0);
        let _ = write!(
            out,
            "<a:pt x=\"{}\" y=\"{}\"/>",
            ((x - bbox.min_x) * EMU_PER_PX).round() as i64,
            ((y - bbox.min_y) * EMU_PER_PX).round() as i64,
        );
        rest = &rest[end..];
    }
    out
}

fn attr(tag: &str, name: &str) -> String {
    let needle = format!("{name}=\"");
    match tag.find(&needle) {
        Some(i) => {
            let s = i + needle.len();
            match tag[s..].find('"') {
                Some(j) => tag[s..s + j].to_string(),
                None => String::new(),
            }
        }
        None => String::new(),
    }
}

/// paint → 단색 hex(RGB). 그라디얼트·패턴은 평균색/기본색으로 단순화(§4-3 4항).
fn paint_hex(paint: Option<&usvg::Paint>) -> Option<String> {
    let paint = paint?;
    match paint {
        usvg::Paint::Color(c) => Some(format!("{:02X}{:02X}{:02X}", c.red, c.green, c.blue)),
        usvg::Paint::LinearGradient(g) => {
            // 양 끝 색의 중간색.
            let a = g.stops().first().map(|s| s.color()).unwrap_or(usvg::Color {
                red: 0,
                green: 0,
                blue: 0,
            });
            let b = g.stops().last().map(|s| s.color()).unwrap_or(usvg::Color {
                red: 0,
                green: 0,
                blue: 0,
            });
            Some(format!(
                "{:02X}{:02X}{:02X}",
                ((a.red as u16 + b.red as u16) / 2) as u8,
                ((a.green as u16 + b.green as u16) / 2) as u8,
                ((a.blue as u16 + b.blue as u16) / 2) as u8
            ))
        }
        usvg::Paint::RadialGradient(g) => {
            let a = g.stops().first().map(|s| s.color()).unwrap_or(usvg::Color {
                red: 0,
                green: 0,
                blue: 0,
            });
            Some(format!("{:02X}{:02X}{:02X}", a.red, a.green, a.blue))
        }
        usvg::Paint::Pattern(_) => Some("808080".into()),
    }
}

/// path 하나 → wps:wsp 도형.
fn path_to_shape(p: &usvg::Path, t: &usvg::Transform, uses_markers: bool) -> String {
    let geom = convert_path(p.data(), t);
    if geom.xml.is_empty() {
        return String::new();
    }
    let off_x = (geom.bbox.min_x * EMU_PER_PX).round() as i64;
    let off_y = (geom.bbox.min_y * EMU_PER_PX).round() as i64;
    let cx = (geom.bbox.width() * EMU_PER_PX).round().max(1.0) as i64;
    let cy = (geom.bbox.height() * EMU_PER_PX).round().max(1.0) as i64;

    let fill = paint_hex(p.fill().map(|f| f.paint()));
    let stroke = p.stroke();
    let stroke_hex = stroke.and_then(|s| paint_hex(Some(s.paint())));
    let stroke_w: f64 = stroke.map(|s| s.width().get() as f64).unwrap_or(0.0);

    let fill_xml = match &fill {
        Some(c) => format!("<a:solidFill><a:srgbClr val=\"{c}\"/></a:solidFill>"),
        None => "<a:noFill/>".to_string(),
    };
    let line_xml = match (&stroke_hex, stroke_w) {
        (Some(c), w) if w > 0.0 => {
            let wemu = (w * EMU_PER_PX).round().max(6350.0) as i64;
            // 화살표: 마커를 쓰는 SVG의 열린 선은 끝에 삼각형(§4-3 3항).
            let arrow = if uses_markers && !geom.closed {
                "<a:tailEnd type=\"triangle\" w=\"med\" len=\"med\"/>"
            } else {
                ""
            };
            format!(
                "<a:ln w=\"{wemu}\" cap=\"flat\" cmpd=\"sng\">\
<a:solidFill><a:srgbClr val=\"{c}\"/></a:solidFill>\
<a:prstDash val=\"solid\"/>{arrow}</a:ln>"
            )
        }
        _ => "<a:ln><a:noFill/></a:ln>".to_string(),
    };

    format!(
        "<wps:wsp><wps:cNvSpPr txBox=\"0\"/><wps:spPr>\
<a:xfrm><a:off x=\"{off_x}\" y=\"{off_y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:rect l=\"0\" t=\"0\" r=\"{cx}\" b=\"{cy}\"/>\
<a:pathLst><a:path w=\"{cx}\" h=\"{cy}\" fill=\"{fill_rule}\">{geom_xml}</a:path></a:pathLst>\
</a:custGeom>{fill_xml}{line_xml}</wps:spPr><wps:bodyPr/></wps:wsp>",
        fill_rule = if geom.closed { "norm" } else { "none" },
        geom_xml = geom.xml,
    )
}

/// text → 편집 가능 텍스트 상자(글꼴 크기·정렬·색 유지).
fn text_to_shape(t: &usvg::Text, tr: &usvg::Transform) -> String {
    let mut shapes = String::new();
    for chunk in t.chunks() {
        let Some(x) = chunk.x() else { continue };
        let Some(y) = chunk.y() else { continue };
        let (ax, ay) = apply(tr, x, y);
        let Some(span) = chunk.spans().first() else {
            continue;
        };
        let text = chunk.text().trim();
        if text.is_empty() {
            continue;
        }
        let font_px = span.font_size().get() as f64; // NonZeroPositiveF32
        let color = span
            .fill()
            .and_then(|f| paint_hex(Some(f.paint())))
            .unwrap_or_else(|| "1F2328".into());
        // 폭 추정: 라틴 ~0.58em, 전각 ~1.0em.
        let width: f64 = text
            .chars()
            .map(|c| if is_wide(c) { 1.0 } else { 0.58 })
            .sum::<f64>()
            * font_px;
        let line_h = font_px * 1.25;
        let box_x = match chunk.anchor() {
            usvg::TextAnchor::Middle => ax - width / 2.0,
            usvg::TextAnchor::End => ax - width,
            usvg::TextAnchor::Start => ax,
        };
        let box_y = ay - font_px * 0.92; // 기준선 → 상자 상단 근사.
        let cx = (width * EMU_PER_PX).ceil().max(1.0) as i64;
        let cy = (line_h * EMU_PER_PX).ceil().max(1.0) as i64;
        let align = match chunk.anchor() {
            usvg::TextAnchor::Middle => "<w:jc w:val=\"center\"/>",
            usvg::TextAnchor::End => "<w:jc w:val=\"right\"/>",
            usvg::TextAnchor::Start => "",
        };
        let half_points = (font_px * 0.75 * 2.0).round().max(2.0) as i64;
        let _ = write!(
            shapes,
            "<wps:wsp><wps:cNvSpPr txBox=\"1\"/><wps:spPr>\
<a:xfrm><a:off x=\"{offx}\" y=\"{offy}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>\
</wps:spPr><wps:txbx><w:txbxContent><w:p><w:pPr>{align}</w:pPr>\
<w:r><w:rPr><w:color w:val=\"{color}\"/><w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/></w:rPr>\
<w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p></w:txbxContent></wps:txbx>\
<wps:bodyPr wrap=\"none\" lIns=\"0\" tIns=\"0\" rIns=\"0\" bIns=\"0\" anchor=\"t\"/></wps:wsp>",
            offx = (box_x * EMU_PER_PX).round() as i64,
            offy = (box_y * EMU_PER_PX).round() as i64,
            sz = half_points,
            text = esc(text),
        );
    }
    shapes
}

fn is_wide(c: char) -> bool {
    // 전각 근사: 한글·한자·가나·전각 문장부호.
    matches!(c as u32,
        0x1100..=0x115F | 0x2E80..=0xA4CF | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF
        | 0xFE30..=0xFE6F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECT_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">
<rect x="10" y="10" width="80" height="30" fill="#4F46E5" stroke="#333" stroke-width="2"/>
</svg>"##;

    #[test]
    fn rect_svg_becomes_custgeom_shape() {
        let xml = svg_to_drawingml(RECT_SVG, 6_000_000).unwrap();
        assert!(xml.contains("wpg:wgp"), "그룹 래퍼가 있어야 한다");
        assert!(xml.contains("a:custGeom"), "custGeom이 있어야 한다");
        assert!(xml.contains("4F46E5"), "채움색이 유지되어야 한다");
        assert!(xml.contains("<a:ln "), "선 서식이 있어야 한다");
        assert!(!xml.contains("<a:prstDash val=\"dash\""));
    }

    #[test]
    fn text_becomes_editable_textbox() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">
<text x="60" y="24" text-anchor="middle" font-size="16" fill="#111" font-family="Helvetica, Arial, sans-serif">Hello</text>
</svg>"##;
        let xml = svg_to_drawingml(svg, 6_000_000).unwrap();
        assert!(xml.contains("wps:txbx"), "텍스트 상자여야 한다");
        assert!(xml.contains("Hello"), "텍스트가 보존되어야 한다");
        assert!(
            xml.contains("w:jc w:val=\"center\""),
            "정렬이 유지되어야 한다"
        );
    }

    #[test]
    fn path_with_marker_gets_arrow_decoration() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50">
<defs><marker id="a" markerWidth="10" markerHeight="10"><path d="M0,0 L10,5 L0,10 z"/></marker></defs>
<path d="M10,25 L80,25" stroke="#333" stroke-width="2" fill="none" marker-end="url(#a)"/>
</svg>"##;
        let xml = svg_to_drawingml(svg, 6_000_000).unwrap();
        assert!(xml.contains("a:tailEnd"), "화살표 끝 장식이 있어야 한다");
    }

    #[test]
    fn sizeless_svg_uses_usvg_default() {
        // width/height 없는 SVG는 usvg 기본 크기(100x100)로 변환된다 — 실패 아님.
        let xml = svg_to_drawingml("<svg xmlns=\"http://www.w3.org/2000/svg\"/>", 1000).unwrap();
        assert!(xml.contains("wpg:wgp"));
    }

    #[test]
    fn invalid_svg_is_rejected() {
        assert!(svg_to_drawingml("not a svg at all", 1000).is_err());
    }

    #[test]
    fn mermaid_flowchart_style_svg_roundtrips() {
        // mermaid flowchart의 전형적 모양: 노드 rect + 라벨 + 연결선.
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
<g class="node"><rect x="5" y="10" width="90" height="40" rx="5" fill="#ECECFF" stroke="#333"/>
<text x="50" y="35" text-anchor="middle" font-size="14">시작</text></g>
<g class="node"><rect x="105" y="10" width="90" height="40" rx="5" fill="#ECECFF" stroke="#333"/>
<text x="150" y="35" text-anchor="middle" font-size="14">끝</text></g>
<path d="M95,30 L105,30" stroke="#333" marker-end="url(#arrow)"/>
</svg>"##;
        let xml = svg_to_drawingml(svg, 5_486_400).unwrap();
        assert!(
            xml.matches("<wps:wsp>").count() >= 5,
            "도형+텍스트 상자 충분히 생성: {}",
            xml.matches("<wps:wsp>").count()
        );
        assert!(xml.contains("시작") && xml.contains("끝"));
        assert!(!xml.contains("<img"), "래스터 없음");
    }
}
