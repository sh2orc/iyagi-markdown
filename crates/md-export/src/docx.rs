//! 마크다운 → DOCX(§4-4). comrak AST를 직접 순회해 OOXML을 만든다.
//! 외부 Pandoc 의존이 없게 직접 작성했다.
//!
//! - 제목·목록·인용·표·코드·링크·이미지를 Word 기본 스타일 이름으로.
//! - mermaid 블록은 SVG→DrawingML로 **편집 가능한 도형 그룹**(§4-3).
//! - 수식($…$·$$…$$)은 MathML→OMML로 **Word 수식 편집기에서 편집 가능**.
//! - SVG 이미지도 도형 그룹으로(래스터화 금지 원칙). 비트맵 이미지는 그대로 포함.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;

use comrak::nodes::{AstNode, NodeCodeBlock, NodeTable, NodeValue, TableAlignment};
use comrak::{parse_document, Arena, Options};

use crate::mathml2omml::mathml_to_omml;
use crate::svg2dml::svg_to_drawingml;
use crate::xml::{esc, PRESERVE};
use crate::ImageSource;

#[derive(Debug, thiserror::Error)]
pub enum DocxError {
    #[error("DOCX 생성 실패: {0}")]
    Build(String),
    #[error("파일 쓰기 실패: {0}")]
    Io(#[from] std::io::Error),
    #[error("zip 압축 실패: {0}")]
    Zip(#[from] zip::result::ZipError),
}

const PAGE_TEXT_WIDTH_EMU: i64 = 5_486_400; // 6in — A4 210mm에서 25mm 여백.

/// 조립 중 수집되는 관계·미디어.
struct Ctx<'a> {
    math: &'a HashMap<String, String>,
    diagrams: &'a HashMap<String, String>,
    images: &'a ImageSource,
    /// 미디어 파일 (이름 → 바이트).
    media: Vec<(String, Vec<u8>)>,
    /// 하이퍼링크 관계 (id → URL). rId는 하이퍼링크 전용 번호로 매긴다.
    hyperlinks: Vec<String>,
    /// 그림 고유 id 시퀀스.
    next_doc_id: i64,
}

impl<'a> Ctx<'a> {
    fn add_media(&mut self, bytes: Vec<u8>, ext: &str) -> String {
        let name = format!("media/image{}.{}", self.media.len() + 1, ext);
        self.media.push((name.clone(), bytes));
        name
    }

    fn add_hyperlink(&mut self, url: &str) -> usize {
        if let Some(i) = self.hyperlinks.iter().position(|u| u == url) {
            return i + 1;
        }
        self.hyperlinks.push(url.to_string());
        self.hyperlinks.len()
    }

    fn next_id(&mut self) -> i64 {
        self.next_doc_id += 1;
        self.next_doc_id
    }
}

/// 진입점: 마크다운 → .docx 파일.
pub fn export_docx(
    markdown: &str,
    math: &HashMap<String, String>,
    diagrams: &HashMap<String, String>,
    images: &ImageSource,
    out: &Path,
    style: Option<(&str, f64, f64, bool, String)>, // (font, pt, 행간, 들여쓰기, 강조색)
) -> Result<(), DocxError> {
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.math_dollars = true;

    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options);

    let mut ctx = Ctx {
        math,
        diagrams,
        images,
        media: Vec::new(),
        hyperlinks: Vec::new(),
        next_doc_id: 100,
    };
    let mut body = String::new();
    for child in root.children() {
        block(child, &mut ctx, &mut body, 0, false)?;
    }
    body.push_str(
        "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>\
<w:pgMar w:top=\"1418\" w:right=\"1418\" w:bottom=\"1418\" w:left=\"1418\"/></w:sectPr>",
    );

    write_docx_zip(out, &body, &ctx, style)?;
    Ok(())
}

// — 블록 —

fn block<'a>(
    node: &'a AstNode<'a>,
    ctx: &mut Ctx<'_>,
    out: &mut String,
    list_level: usize,
    in_quote: bool,
) -> Result<(), DocxError> {
    match &node.data.borrow().value {
        NodeValue::Paragraph => {
            let runs = inline_children(node, ctx, list_level)?;
            let quote = if in_quote {
                " w:val=\"IYAGIQuote\""
            } else {
                ""
            };
            let _ = writeln!(out, "<w:p><w:pPr><w:pStyle{quote}/></w:pPr>{runs}</w:p>");
        }
        NodeValue::Heading(h) => {
            let runs = inline_children(node, ctx, list_level)?;
            let level = h.level.clamp(1, 6);
            let _ = writeln!(
                out,
                "<w:p><w:pPr><w:pStyle w:val=\"Heading{level}\"/></w:pPr>{runs}</w:p>"
            );
        }
        NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_) => {
            for c in node.children() {
                block(c, ctx, out, list_level, true)?;
            }
        }
        NodeValue::List(_) => {
            for c in node.children() {
                list_item(c, ctx, out, list_level)?;
            }
        }
        NodeValue::CodeBlock(cb) => code_block(cb, ctx, out)?,
        NodeValue::ThematicBreak => {
            out.push_str(
                "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"8\" w:space=\"1\" w:color=\"999999\"/></w:pBdr></w:pPr></w:p>",
            );
        }
        NodeValue::HtmlBlock(_) => {
            // raw HTML은 내용 없이 건너뛴다(원문은 .md에 있다 — §4-2 3항).
        }
        NodeValue::Table(t) => table(node, t, ctx, out)?,
        NodeValue::Math(m) if m.display_math => {
            math_paragraph(&m.literal, ctx, out);
        }
        NodeValue::FootnoteDefinition(_) | NodeValue::DescriptionList => {
            for c in node.children() {
                block(c, ctx, out, list_level, in_quote)?;
            }
        }
        _ => {
            // 나머지는 자식을 일반 블록으로.
            for c in node.children() {
                block(c, ctx, out, list_level, in_quote)?;
            }
        }
    }
    Ok(())
}

fn list_item<'a>(
    node: &'a AstNode<'a>,
    ctx: &mut Ctx,
    out: &mut String,
    level: usize,
) -> Result<(), DocxError> {
    let ilvl = level.min(8);
    for c in node.children() {
        match &c.data.borrow().value {
            NodeValue::Paragraph => {
                let task = if let NodeValue::TaskItem(t) = &node.data.borrow().value {
                    t.symbol.is_some()
                } else {
                    false
                };
                let checked = if let NodeValue::TaskItem(t) = &node.data.borrow().value {
                    t.symbol.is_some()
                } else {
                    false
                };
                let _ = task;
                let checkbox = if matches!(node.data.borrow().value, NodeValue::TaskItem(_)) {
                    format!(
                        "<w:r><w:rPr><w:sz w:val=\"22\"/></w:rPr><w:sym w:font=\"Wingdings\" w:char=\"F0{}\"/></w:r>",
                        if checked { "FE" } else { "A8" }
                    )
                } else {
                    String::new()
                };
                let runs = inline_children(c, ctx, level)?;
                let _ = writeln!(
                    out,
                    "<w:p><w:pPr><w:numPr><w:ilvl w:val=\"{ilvl}\"/><w:numId w:val=\"{num}\"/></w:numPr></w:pPr>{checkbox}{runs}</w:p>",
                    num = list_num_id(node),
                );
            }
            NodeValue::List(_) => block(c, ctx, out, level + 1, false)?,
            other => {
                let _ = other;
                block(c, ctx, out, level, false)?;
            }
        }
    }
    Ok(())
}

/// 이 항목이 속한 목록이 번호 목록이면 2, 아니면 1(numbering.xml 정의 순서).
fn list_num_id(item: &AstNode<'_>) -> i64 {
    use comrak::nodes::ListType;
    // Item의 부모 List 정보는 형제 구조상 Item 노드에 없다 — 실제로는 Item이
    // NodeList를 품고 있다(comrak 관례). ordered면 2.
    if let NodeValue::Item(nl) = &item.data.borrow().value {
        if nl.list_type == ListType::Ordered {
            return 2;
        }
    }
    1
}

fn code_block(cb: &NodeCodeBlock, ctx: &mut Ctx, out: &mut String) -> Result<(), DocxError> {
    let info = cb.info.trim().to_ascii_lowercase();
    let code = cb.literal.trim_matches('\n');
    // mermaid → 편집 가능 도형 그룹(§4-3).
    if info == "mermaid" {
        if let Some(svg) = ctx.diagrams.get(code) {
            match svg_to_drawingml(svg, PAGE_TEXT_WIDTH_EMU) {
                Ok(drawing) => {
                    let _ = writeln!(out, "<w:p>{drawing}</w:p>");
                    return Ok(());
                }
                Err(e) => {
                    // 실패 시 코드로 폴백 — 래스터는 만들지 않는다.
                    let _ = e;
                }
            }
        }
    }
    if info == "math" {
        math_paragraph(code, ctx, out);
        return Ok(());
    }
    // 일반 코드: 각 줄을 한 문단으로(배경·고정폭).
    for line in code.split('\n') {
        let _ = writeln!(
            out,
            "<w:p><w:pPr><w:pStyle w:val=\"IYAGICode\"/><w:ind w:left=\"0\"/></w:pPr>\
<w:r><w:rPr><w:rFonts w:ascii=\"Menlo\" w:hAnsi=\"Menlo\"/><w:sz w:val=\"18\"/></w:rPr><w:t{PRESERVE}>{}</w:t></w:r></w:p>",
            esc(line)
        );
    }
    Ok(())
}

fn math_paragraph(latex: &str, ctx: &Ctx, out: &mut String) {
    let key = latex.trim();
    let omml = ctx
        .math
        .get(key)
        .and_then(|ml| mathml_to_omml(ml).ok())
        .unwrap_or_else(|| {
            // 매니페스트에 없으면 원문을 수식 안 텍스트로(편집 가능, 폴백 아님).
            format!(
                "<m:oMath><m:r><w:rPr><w:rFonts w:ascii=\"Cambria Math\" w:hAnsi=\"Cambria Math\"/></w:rPr><m:t{PRESERVE}>{}</m:t></m:r></m:oMath>",
                esc(key)
            )
        });
    let _ = writeln!(
        out,
        "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr>{omml}</w:p>"
    );
}

// — 표 —

fn table<'a>(
    node: &'a AstNode<'a>,
    t: &NodeTable,
    ctx: &mut Ctx<'_>,
    out: &mut String,
) -> Result<(), DocxError> {
    let n_cols = t.num_columns;
    // 열 폭: 균등(텍스트 폭 5537× twip? 6in=8640 twip).
    let col_tw = 8640 / n_cols.max(1);
    let _ = write!(
        out,
        "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/>\
<w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>\
<w:top w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/>\
<w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/>\
<w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/>\
</w:tblBorders></w:tblPr><w:tblGrid>"
    );
    for _ in 0..n_cols {
        let _ = write!(out, "<w:gridCol w:w=\"{col_tw}\"/>");
    }
    out.push_str("</w:tblGrid>");

    let mut col_idx;
    let mut is_header;
    for row in node.children() {
        if let NodeValue::TableRow(header) = &row.data.borrow().value {
            is_header = *header;
            col_idx = 0;
            out.push_str("<w:tr>");
            if is_header {
                out.push_str("<w:trPr><w:tblHeader/></w:trPr>");
            }
            for cell in row.children() {
                let align = t.alignments.get(col_idx).copied();
                let runs = inline_children(cell, ctx, 0)?;
                let jc = match align {
                    Some(TableAlignment::Center) => "<w:jc w:val=\"center\"/>",
                    Some(TableAlignment::Right) => "<w:jc w:val=\"right\"/>",
                    _ => "",
                };
                let shade = if is_header {
                    "<w:shd w:val=\"clear\" w:fill=\"F2F3F5\"/>"
                } else {
                    ""
                };
                let bold = if is_header { "<w:b/>" } else { "" };
                // 헤더는 rPr b를 각 run에 넣을 수 없어 셀 수준 스타일로.
                let _ = write!(
                    out,
                    "<w:tc><w:tcPr>{shade}<w:tcW w:w=\"{col_tw}\" w:type=\"dxa\"/></w:tcPr>\
<w:p><w:pPr>{jc}<w:rPr>{bold}</w:rPr></w:pPr>{runs}</w:p></w:tc>"
                );
                col_idx += 1;
            }
            out.push_str("</w:tr>");
        }
    }
    // 표 뒤 빈 문단(Word 관례).
    out.push_str("</w:tbl><w:p/>");
    Ok(())
}

// — 인라인 —

struct RunStyle {
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
    sup: bool,
    sub: bool,
}

fn rpr(style: &RunStyle) -> String {
    let mut s = String::new();
    if style.bold {
        s.push_str("<w:b/>");
    }
    if style.italic {
        s.push_str("<w:i/>");
    }
    if style.strike {
        s.push_str("<w:strike/>");
    }
    if style.sup {
        s.push_str("<w:vertAlign w:val=\"superscript\"/>");
    }
    if style.sub {
        s.push_str("<w:vertAlign w:val=\"subscript\"/>");
    }
    if style.code {
        s.push_str("<w:rFonts w:ascii=\"Menlo\" w:hAnsi=\"Menlo\"/><w:shd w:val=\"clear\" w:fill=\"F4F4F6\"/>");
    }
    if s.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{s}</w:rPr>")
    }
}

fn text_run(text: &str, style: &RunStyle) -> String {
    if text.is_empty() {
        return String::new();
    }
    format!(
        "<w:r>{}<w:t{}>{}</w:t></w:r>",
        rpr(style),
        PRESERVE,
        esc(text)
    )
}

fn inline_children<'a>(
    node: &'a AstNode<'a>,
    ctx: &mut Ctx<'_>,
    level: usize,
) -> Result<String, DocxError> {
    let mut out = String::new();
    for c in node.children() {
        inline(
            c,
            ctx,
            &mut out,
            &RunStyle {
                bold: false,
                italic: false,
                strike: false,
                code: false,
                sup: false,
                sub: false,
            },
            level,
        )?;
    }
    Ok(out)
}

fn inline<'a>(
    node: &'a AstNode<'a>,
    ctx: &mut Ctx<'_>,
    out: &mut String,
    style: &RunStyle,
    _level: usize,
) -> Result<(), DocxError> {
    match &node.data.borrow().value {
        NodeValue::Text(t) => out.push_str(&text_run(t, style)),
        NodeValue::Code(c) => out.push_str(&text_run(
            &c.literal,
            &RunStyle {
                code: true,
                ..*style
            },
        )),
        NodeValue::SoftBreak => out.push(' '),
        NodeValue::LineBreak => out.push_str("<w:r><w:br/></w:r>"),
        NodeValue::Emph => {
            let s = RunStyle {
                italic: true,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, out, &s, _level)?;
            }
        }
        NodeValue::Strong => {
            let s = RunStyle {
                bold: true,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, out, &s, _level)?;
            }
        }
        NodeValue::Strikethrough => {
            let s = RunStyle {
                strike: true,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, out, &s, _level)?;
            }
        }
        NodeValue::Superscript => {
            let s = RunStyle {
                sup: true,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, out, &s, _level)?;
            }
        }
        NodeValue::Subscript => {
            let s = RunStyle {
                sub: true,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, out, &s, _level)?;
            }
        }
        NodeValue::Underline => {
            for c in node.children() {
                inline(c, ctx, out, style, _level)?;
            }
        }
        NodeValue::Link(link) => {
            let id = ctx.add_hyperlink(&link.url);
            let mut runs = String::new();
            let s = RunStyle {
                italic: false,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, &mut runs, &s, _level)?;
            }
            let _ = write!(out, "<w:hyperlink r:id=\"rIdH{id}\">{runs}</w:hyperlink>");
        }
        NodeValue::Image(link) => {
            if let Some(drawing) = image_drawing(ctx, &link.url) {
                out.push_str(&drawing);
            } else {
                // 파일을 읽지 못하면 대체 텍스트.
                let alt: String = node
                    .children()
                    .map(|c| match &c.data.borrow().value {
                        NodeValue::Text(t) => t.to_string(),
                        _ => String::new(),
                    })
                    .collect();
                out.push_str(&text_run(&format!("[{alt}]"), style));
            }
        }
        NodeValue::Math(m) => {
            let omml = ctx
                .math
                .get(m.literal.trim())
                .and_then(|ml| mathml_to_omml(ml).ok())
                .unwrap_or_else(|| {
                    format!(
                        "<m:oMath><m:r><w:rPr><w:rFonts w:ascii=\"Cambria Math\" w:hAnsi=\"Cambria Math\"/></w:rPr><m:t{}>{}</m:t></m:r></m:oMath>",
                        PRESERVE,
                        esc(&m.literal)
                    )
                });
            out.push_str(&omml);
        }
        NodeValue::HtmlInline(_) | NodeValue::Escaped | NodeValue::Raw(_) => {}
        NodeValue::TaskItem(_) => {}
        _ => {
            for c in node.children() {
                inline(c, ctx, out, style, _level)?;
            }
        }
    }
    Ok(())
}

/// 이미지 → 인라인 그림(비트맵) 또는 도형 그룹(SVG, §4-3).
fn image_drawing(ctx: &mut Ctx, url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    if lower.ends_with(".svg") || lower.contains(".svg?") {
        let svg = ctx.images.read(url)?;
        let svg = String::from_utf8(svg).ok()?;
        let drawing = svg_to_drawingml(&svg, PAGE_TEXT_WIDTH_EMU).ok()?;
        return Some(format!("<w:p>{drawing}</w:p>"));
    }
    let bytes = ctx.images.read(url)?;
    let ext = detect_image(&bytes)?;
    // 크기: 이미지 헤더에서 추출, 실패 시 4x3in.
    let (w_px, h_px) = image_dimensions(&bytes).unwrap_or((384, 288));
    let scale = (PAGE_TEXT_WIDTH_EMU as f64 / (w_px as f64 * 9525.0)).min(1.0);
    let cx = (w_px as f64 * 9525.0 * scale).round() as i64;
    let cy = (h_px as f64 * 9525.0 * scale).round() as i64;
    let name = ctx.add_media(bytes, ext);
    let id = ctx.next_id();
    Some(format!(
        "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">\
<wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>\
<wp:docPr id=\"{id}\" name=\"Image {id}\"/>\
<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>\
<a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
<pic:pic><pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr>\
<pic:blipFill><a:blip r:embed=\"rIdImg{id}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
<pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm>\
<a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>\
</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
    ))
}

fn detect_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("gif")
    } else if bytes.starts_with(b"BM") {
        Some("bmp")
    } else {
        None
    }
}

/// PNG/JPEG/GIF 크기 헤더 파싱(외부 크레이트 없이).
fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        if bytes.len() > 24 {
            let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
            let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
            return Some((w, h));
        }
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        // JPEG SOF 스캔.
        let mut i = 2usize;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            let len = u16::from_be_bytes(bytes[i + 2..i + 4].try_into().ok()?) as usize;
            if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC
            {
                let h = u16::from_be_bytes(bytes[i + 5..i + 7].try_into().ok()?) as u32;
                let w = u16::from_be_bytes(bytes[i + 7..i + 9].try_into().ok()?) as u32;
                return Some((w, h));
            }
            i += 2 + len;
        }
    } else if bytes.starts_with(b"GIF8") && bytes.len() > 10 {
        let w = u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32;
        let h = u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32;
        return Some((w, h));
    }
    None
}

// — 패키지(zip) 작성 —

fn write_docx_zip(
    out: &Path,
    body: &str,
    ctx: &Ctx,
    style: Option<(&str, f64, f64, bool, String)>,
) -> Result<(), DocxError> {
    let file = std::fs::File::create(out)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let add = |zip: &mut zip::ZipWriter<std::fs::File>, name: &str, data: &str| -> Result<(), DocxError> {
        zip.start_file(name, opts)?;
        Ok(zip.write_all(data.as_bytes())?)
    };

    add(&mut zip, "[Content_Types].xml", &content_types(ctx))?;
    add(&mut zip, "_rels/.rels", RELS_ROOT)?;
    add(&mut zip, "word/document.xml", &document(body))?;
    add(
        &mut zip,
        "word/_rels/document.xml.rels",
        &document_rels(ctx),
    )?;
    add(&mut zip, "word/styles.xml", &styles_xml(style))?;
    add(&mut zip, "word/numbering.xml", NUMBERING)?;
    add(&mut zip, "word/settings.xml", SETTINGS)?;
    add(&mut zip, "docProps/core.xml", &core_props())?;
    add(&mut zip, "docProps/app.xml", APP)?;

    for (name, bytes) in &ctx.media {
        zip.start_file(format!("word/{name}"), opts)?;
        zip.write_all(bytes)?;
    }
    zip.finish()?;
    Ok(())
}

fn content_types(ctx: &Ctx) -> String {
    let mut media_defaults = String::new();
    let mut seen = std::collections::HashSet::new();
    for (_, bytes) in &ctx.media {
        let ext = detect_image(bytes).unwrap_or("png");
        if seen.insert(ext) {
            let mime = match ext {
                "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "bmp" => "image/bmp",
                _ => "image/png",
            };
            let _ = write!(
                media_defaults,
                "<Default Extension=\"{ext}\" ContentType=\"{mime}\"/>"
            );
        }
    }
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
            "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
            "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
            "{media}",
            "<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>",
            "<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>",
            "<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>",
            "<Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/>",
            "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>",
            "<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>",
            "</Types>",
        ),
        media = media_defaults,
    )
}

const RELS_ROOT: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>"#;

fn document(body: &str) -> String {
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" ",
            "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" ",
            "xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" ",
            "xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" ",
            "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" ",
            "xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\" ",
            "xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\" ",
            "xmlns:wpg=\"http://schemas.microsoft.com/office/word/2010/wordprocessingGroup\">",
            "<w:body>{}</w:body></w:document>",
        ),
        body
    )
}

fn document_rels(ctx: &Ctx) -> String {
    let mut s = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>"#,
    );
    for (i, url) in ctx.hyperlinks.iter().enumerate() {
        let _ = write!(
            s,
            "<Relationship Id=\"rIdH{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",
            i + 1,
            esc(url)
        );
    }
    for (idx, (name, _)) in ctx.media.iter().enumerate() {
        let id = ctx.next_doc_id - (ctx.media.len() - idx) as i64;
        let _ = write!(
            s,
            "<Relationship Id=\"rIdImg{id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"{name}\"/>"
        );
    }
    s.push_str("</Relationships>");
    s
}

/// 문서별 서체(라이브 프리뷰 스타일) — 폰트·크기·행간·첫 줄 들여쓰기·강조색.
fn styles_xml(style: Option<(&str, f64, f64, bool, String)>) -> String {
    let (ascii, east_asia, half_points, line, indent, accent) = match style {
        Some(("serif", pt, lh, fi, ac)) => (
            "Georgia",
            "AppleMyungjo",
            (pt * 2.0).round() as i64,
            if lh > 0.0 { lh } else { 1.15 },
            fi,
            ac.to_string(),
        ),
        Some(("mono", pt, lh, fi, ac)) => (
            "Menlo",
            "Apple SD Gothic Neo",
            (pt * 2.0).round() as i64,
            if lh > 0.0 { lh } else { 1.15 },
            fi,
            ac.to_string(),
        ),
        Some(("round", pt, lh, fi, ac)) => (
            "Helvetica Neue",
            "Apple SD Gothic Neo",
            (pt * 2.0).round() as i64,
            if lh > 0.0 { lh } else { 1.15 },
            fi,
            ac.to_string(),
        ),
        Some((_, pt, lh, fi, ac)) => (
            "-apple-system",
            "Apple SD Gothic Neo",
            (pt * 2.0).round() as i64,
            if lh > 0.0 { lh } else { 1.15 },
            fi,
            ac.to_string(),
        ),
        None => ("-apple-system", "Apple SD Gothic Neo", 22, 1.15, false, String::new()),
    };
    let heading_scale = |mult: f64, base: i64| ((base as f64 * mult).round() as i64).to_string();
    let base = half_points;
    let h1 = heading_scale(1.45, base);
    let h2 = heading_scale(1.24, base);
    let h3 = heading_scale(1.12, base);
    // 행간(240 = 단일)과 첫 줄 들여쓰기(1.25em ≈ 폰트 크기의 1.25배 twip).
    let line_rule = format!("{:.0}", (line * 240.0).round());
    let indent_tw = format!("{:.0}", (base as f64 / 2.0) * 1.25 * 20.0);
    let para_extra = if indent {
        format!("<w:ind w:firstLine=\"{indent_tw}\"/>")
    } else {
        String::new()
    };
    // 강조색 — 링크색(hyperlink 스타일)으로 반영.
    let hyperlink_color = if accent.is_empty() {
        "0563C1".to_string()
    } else {
        accent.trim_start_matches('#').to_uppercase()
    };
    STYLES_TEMPLATE
        .replace("@ASCII@", ascii)
        .replace("@EASTASIA@", east_asia)
        .replace("@SZ@", &base.to_string())
        .replace("@H1@", &h1)
        .replace("@H2@", &h2)
        .replace("@H3@", &h3)
        .replace("@LINE@", &line_rule)
        .replace("@INDENT@", &para_extra)
        .replace("@LINKCLR@", &hyperlink_color)
}

const STYLES_TEMPLATE: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:pPrDefault><w:pPr><w:spacing w:line="@LINE@" w:lineRule="auto"/>@INDENT@</w:pPr></w:pPrDefault><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="@ASCII@" w:hAnsi="@ASCII@" w:eastAsia="@EASTASIA@"/>
<w:sz w:val="@SZ@"/><w:szCs w:val="@SZ@"/>
</w:rPr></w:rPrDefault><w:pPrDefault/></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>
<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/>
<w:spacing w:before="280" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="@H1@"/><w:szCs w:val="@H1@"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>
<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/>
<w:spacing w:before="240" w:after="100"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="@H2@"/><w:szCs w:val="@H2@"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/>
<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/>
<w:spacing w:before="220" w:after="90"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="@H3@"/><w:szCs w:val="@H3@"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/>
<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="3"/>
<w:spacing w:before="200" w:after="80"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/>
<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="4"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/>
<w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="5"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="IYAGICode"><w:name w:val="IYAGI Code"/>
<w:basedOn w:val="Normal"/>
<w:pPr><w:shd w:val="clear" w:fill="F4F4F6"/><w:spacing w:before="0" w:after="0" w:line="264" w:lineRule="auto"/>
<w:ind w:left="180"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="IYAGIQuote"><w:name w:val="IYAGI Quote"/>
<w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="C7CAD1"/></w:pBdr></w:pPr>
<w:rPr><w:i/><w:color w:val="59636E"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>
<w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:color="B8BCC4"/><w:left w:val="single" w:sz="4" w:color="B8BCC4"/>
<w:bottom w:val="single" w:sz="4" w:color="B8BCC4"/><w:right w:val="single" w:sz="4" w:color="B8BCC4"/>
<w:insideH w:val="single" w:sz="4" w:color="B8BCC4"/><w:insideV w:val="single" w:sz="4" w:color="B8BCC4"/>
</w:tblBorders></w:tblPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>
<w:rPr><w:color w:val="@LINKCLR@"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>"#;

const NUMBERING: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="10"><w:multiLevelType w:val="hybridMultilevel"/>
<lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="●"/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="360" w:hanging="240"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></lvl>
<lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="○"/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="720" w:hanging="280"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></lvl>
<lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="■"/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="1080" w:hanging="320"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></lvl>
<lvl w:ilvl="3"><w:numFmt w:val="bullet"/><w:lvlText w:val="●"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></lvl>
<lvl w:ilvl="4"><w:numFmt w:val="bullet"/><w:lvlText w:val="○"/><w:pPr><w:ind w:left="1800" w:hanging="400"/></w:pPr></lvl>
<lvl w:ilvl="5"><w:numFmt w:val="bullet"/><w:lvlText w:val="■"/><w:pPr><w:ind w:left="2160" w:hanging="440"/></w:pPr></lvl>
<lvl w:ilvl="6"><w:numFmt w:val="bullet"/><w:lvlText w:val="●"/><w:pPr><w:ind w:left="2520" w:hanging="480"/></w:pPr></lvl>
<lvl w:ilvl="7"><w:numFmt w:val="bullet"/><w:lvlText w:val="○"/><w:pPr><w:ind w:left="2880" w:hanging="520"/></w:pPr></lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="20"><w:multiLevelType w:val="hybridMultilevel"/>
<lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="360" w:hanging="240"/></w:pPr></lvl>
<lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="720" w:hanging="280"/></w:pPr></lvl>
<lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%3."/><w:lvlJc w:val="left"/>
<w:pPr><w:ind w:left="1080" w:hanging="320"/></w:pPr></lvl>
<lvl w:ilvl="3"><w:numFmt w:val="decimal"/><w:lvlText w:val="%4."/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></lvl>
<lvl w:ilvl="4"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%5."/><w:pPr><w:ind w:left="1800" w:hanging="400"/></w:pPr></lvl>
<lvl w:ilvl="5"><w:numFmt w:val="lowerRoman"/><w:lvlText w:val="%6."/><w:pPr><w:ind w:left="2160" w:hanging="440"/></w:pPr></lvl>
<lvl w:ilvl="6"><w:numFmt w:val="decimal"/><w:lvlText w:val="%7."/><w:pPr><w:ind w:left="2520" w:hanging="480"/></w:pPr></lvl>
<lvl w:ilvl="7"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%8."/><w:pPr><w:ind w:left="2880" w:hanging="520"/></w:pPr></lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num>
</w:numbering>"#;

const SETTINGS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
<w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/>
<w:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="before"/>
<m:brkBinSub m:val="--"/><m:smallFrac m:val="0"/><m:dispDef/>
<m:lMargin m:val="0"/> <m:rMargin m:val="0"/><m:defJc m:val="centerGroup"/>
<m:wrapIndent m:val="1440"/><m:intLim m:val="subSup"/><m:naryLim m:val="undOvr"/></m:mathPr>
</w:settings>"#;

fn core_props() -> String {
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" ",
        "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" ",
        "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">",
        "<dc:title>IYAGI Markdown 문서</dc:title>",
        "<dc:creator>IYAGI Markdown</dc:creator>",
        "<cp:lastModifiedBy>IYAGI Markdown</cp:lastModifiedBy>",
        "</cp:coreProperties>",
    )
    .to_string()
}

const APP: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>IYAGI Markdown</Application></Properties>"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p =
            std::env::temp_dir().join(format!("md-export-docx-{tag}-{}.docx", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn basic_document_with_all_blocks() {
        let md = "# 제목\n\n**굵게**와 *기울임*, `code`, ~~취소~~.\n\n- 항목\n- [ ] 할 일\n\n1. 첫째\n\n> 인용\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```rust\nfn main() {}\n```\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("basic");
        export_docx(md, &math, &diagrams, &images, &out, None).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        assert!(bytes.len() > 2000);
        // zip 매직.
        assert_eq!(&bytes[0..2], b"PK");
        // 내용 확인 — 압축 해제.
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        let doc = {
            let mut s = String::new();
            use std::io::Read;
            zip.by_name("word/document.xml")
                .unwrap()
                .read_to_string(&mut s)
                .unwrap();
            s
        };
        assert!(doc.contains("Heading1"));
        assert!(doc.contains("제목"));
        assert!(doc.contains("<w:b/>"));
        assert!(doc.contains("w:tbl"));
        assert!(doc.contains("Menlo"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn math_uses_omml_when_manifest_has_it() {
        let md = "$$x^2$$\n";
        // 매니페스트는 KaTeX output:'mathml'의 **MathML 원문**을 담는다.
        let math_ml =
            "<math xmlns=\"http://www.w3.org/1998/Math/MathML\"><msup><mi>x</mi><mn>2</mn></msup></math>";
        let mut math = HashMap::new();
        math.insert("x^2".to_string(), math_ml.to_string());
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("math");
        export_docx(md, &math, &diagrams, &images, &out, None).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        let doc = {
            let mut s = String::new();
            use std::io::Read;
            zip.by_name("word/document.xml")
                .unwrap()
                .read_to_string(&mut s)
                .unwrap();
            s
        };
        assert!(doc.contains("<m:oMath>"));
        assert!(doc.contains("m:sSup"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn mermaid_becomes_drawing_shapes() {
        let md = "```mermaid\nflowchart LR\n  A-->B\n```\n";
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">
<rect x="5" y="5" width="50" height="30" fill="#ECECFF" stroke="#333"/>
<text x="30" y="25" text-anchor="middle" font-size="12" font-family="Helvetica">A</text>
</svg>"##;
        let mut diagrams = HashMap::new();
        diagrams.insert("flowchart LR\n  A-->B".to_string(), svg.to_string());
        let math = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("mermaid");
        export_docx(md, &math, &diagrams, &images, &out, None).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        let doc = {
            let mut s = String::new();
            use std::io::Read;
            zip.by_name("word/document.xml")
                .unwrap()
                .read_to_string(&mut s)
                .unwrap();
            s
        };
        assert!(
            doc.contains("wpg:wgp"),
            "도형 그룹: {}",
            &doc[doc.len().min(400)..]
        );
        assert!(doc.contains("wps:txbx"), "텍스트 편집 가능 상자");
        assert!(
            !doc.contains("<w:sym w:char=\"F0A8\"/>flowchart"),
            "코드 폴백이 아님"
        );
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn png_image_is_embedded() {
        // 1x1 빨강 PNG.
        let png: &[u8] = &[
            0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, b'I', b'H', b'D', b'R',
            0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xDE,
        ];
        let dir = std::env::temp_dir().join(format!("md-export-img-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("dot.png"), png).unwrap();
        let md = "![점](dot.png)\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(dir.to_string_lossy().into_owned());
        let out = tmp("img");
        export_docx(md, &math, &diagrams, &images, &out, None).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let zip = zip::ZipArchive::new(cursor).unwrap();
        let names: Vec<String> = zip
            .file_names()
            .filter_map(|s| s.ok())
            .map(|s| s.into_owned())
            .collect();
        assert!(
            names.iter().any(|n| n.starts_with("word/media/")),
            "미디어 포함: {names:?}"
        );
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
