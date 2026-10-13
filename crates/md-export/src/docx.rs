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
    /// 각주 정의(순서 = id). 라벨 → id(1부터).
    footnotes: Vec<String>,
    /// 문서별 표 열 폭(px) — 헤더 내용 키(사이드카).
    table_widths: std::collections::HashMap<String, Vec<u32>>,
    /// 그림 캡션 번호(SEQ 초기값 — Word가 갱신).
    figures: u32,
    /// 표 캡션 번호(SEQ Table).
    tables: u32,
    footnote_ids: std::collections::HashMap<String, usize>,
    /// 북마크 슬러그 중복 카운터(GitHub식 -1 접미 — 프런트 tocMarkdown과 같은 규칙).
    slug_seen: std::collections::HashMap<String, usize>,
}

impl<'a> Ctx<'a> {
    /// GitHub식 슬러그 + 문서 내 중복 -1 접미(프런트 links.ts와 같은 규칙).
    fn bookmark_slug(&mut self, text: &str) -> String {
        let base = md_core::links::slug_heading(text);
        let n = self.slug_seen.entry(base.clone()).or_insert(0);
        *n += 1;
        let dedup = *n;
        if dedup == 1 {
            base
        } else {
            format!("{base}-{}", dedup - 1)
        }
    }

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

/// 내보내기 옵션 묶음 — export_docx 인자가 늘어 구조체로.
pub struct DocxExportOptions<'a> {
    pub math: &'a HashMap<String, String>,
    pub diagrams: &'a HashMap<String, String>,
    pub images: &'a ImageSource,
    /// (font, pt, 행간, 들여쓰기, 강조색, 정렬).
    pub style: Option<(&'a str, f64, f64, bool, String, String)>,
    pub page_numbers: bool,
    /// 헤더 내용 키 → 열 px(사이드카).
    pub table_widths: &'a HashMap<String, Vec<u32>>,
    /// 프런트매터 메타 — core.xml 식별자.
    pub title: Option<&'a str>,
    pub author: Option<&'a str>,
    /// 네이티브 목차(TOC 필드) 삽입 — 열 때 Word가 채운다.
    pub toc: bool,
    /// 머리글 문서 제목(Some이면 매 페이지 상단, PDF와 같은 관례).
    pub header_title: Option<&'a str>,
    /// 형광펜 색(RRGGBB — 없으면 기본 노랑).
    pub highlight: Option<&'a str>,
}

/// 진입점: 마크다운 → .docx 파일.
pub fn export_docx(
    markdown: &str,
    opts: &DocxExportOptions<'_>,
    out: &Path,
) -> Result<(), DocxError> {
    let DocxExportOptions { math, diagrams, images, style, page_numbers, table_widths, toc, header_title, highlight, .. } = opts;
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.math_dollars = true;

    // 각주는 comrak가 [\^라벨]: 를 링크 참조 정의로 소비하므로 파싱 전에 추출.
    let (body_md, footnote_defs) = extract_footnotes(markdown);

    let arena = Arena::new();
    let root = parse_document(&arena, &body_md, &options);

    let mut ctx = Ctx {
        math,
        diagrams,
        images,
        media: Vec::new(),
        hyperlinks: Vec::new(),
        next_doc_id: 100,
        footnotes: Vec::new(),
        table_widths: (*table_widths).clone(),
        footnote_ids: std::collections::HashMap::new(),
        slug_seen: std::collections::HashMap::new(),
        figures: 0,
        tables: 0,
    };
    set_hl_fill(highlight.filter(|h| !h.is_empty()).unwrap_or("FFF3A3"));
    // 추출한 각주 정의를 Ctx에 등록 — 각각 마크다운으로 파싱해 인라인 서식
    // (굵게·링크·수식)까지 각주 안에 유지.
    for (label, def_md) in &footnote_defs {
        let droot = parse_document(&arena, def_md, &options);
        let para = droot
            .children()
            .find(|c| matches!(c.data.borrow().value, NodeValue::Paragraph));
        let runs = match para {
            Some(p) => inline_children(p, &mut ctx, 0).unwrap_or_default(),
            None => plain_run(def_md, &RunStyle::default()),
        };
        ctx.footnote_ids.insert(label.clone(), ctx.footnotes.len() + 1);
        // 각주 번호 위첨자 + 정의 런(footnotes_xml이 <w:p> 골격을 낸다).
        ctx.footnotes.push(runs);
    }
    let mut body = String::new();
    if *toc {
        body.push_str(&toc_field());
    }
    for child in root.children() {
        block(child, &mut ctx, &mut body, 0, false)?;
    }
    body.push_str(&sect_pr(*page_numbers, header_title.is_some()));

    // 각주 참조 자리표시자(\\u{E000}라벨\\u{E000}) → footnoteReference 런.
    let body = resolve_footnote_refs(&body, &ctx);

    write_docx_zip(out, &body, &ctx, opts, style.clone())?;
    Ok(())
}

/// 네이티브 목차 필드 — w:dirty로 열 때 Word가 항목을 채운다(제목 1~3,
/// 하이퍼링크). 문서 첫머리에 "목차" 제목과 함께.
fn toc_field() -> String {
    concat!(
        "<w:sdt><w:sdtPr><w:docPartObj>",
        "<w:docPartGallery w:val=\"Table of Contents\"/><w:docPartUnique/>",
        "</w:docPartObj></w:sdtPr><w:sdtContent>",
        "<w:p><w:pPr><w:pStyle w:val=\"TOCHeading\"/></w:pPr>",
        "<w:r><w:t>목차</w:t></w:r></w:p>",
        "<w:p><w:pPr><w:pStyle w:val=\"TOC1\"/></w:pPr>",
        "<w:r><w:fldChar w:fldCharType=\"begin\" w:dirty=\"true\"/></w:r>",
        "<w:r><w:instrText xml:space=\"preserve\"> TOC \\o \"1-3\" \\h \\z \\u </w:instrText></w:r>",
        "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
        "<w:r><w:t>(Word에서 열면 목차가 채워집니다)</w:t></w:r>",
        "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>",
        "</w:p></w:sdtContent></w:sdt>",
        "<w:p/>"
    )
    .to_string()
}

/// 섹션 속성 — A4·25mm 여백. 페이지 번호면 바닥글 참조가 먼저 온다(규격 순서).
fn sect_pr(page_numbers: bool, has_header: bool) -> String {
    let footer = if page_numbers {
        "<w:footerReference w:type=\"default\" r:id=\"rIdFooter\"/>"
    } else {
        ""
    };
    let header = if has_header {
        // 표지 관례: 1쪽은 빈 머리글(titlePg) — 본문 H1 제목과 중복하지 않게.
        "<w:headerReference w:type=\"default\" r:id=\"rIdHeader\"/>\
<w:headerReference w:type=\"first\" r:id=\"rIdHeaderFirst\"/><w:titlePg/>"
    } else {
        ""
    };
    format!(
        "<w:sectPr>{header}{footer}<w:pgSz w:w=\"11906\" w:h=\"16838\"/>\
<w:pgMar w:top=\"1418\" w:right=\"1418\" w:bottom=\"1418\" w:left=\"1418\"/></w:sectPr>"
    )
}

/// 캡션으로 쓸 만한 alt인지 — 프런트 caption.ts와 같은 규칙.
fn caption_worthy(alt: &str) -> bool {
    let t = alt.trim();
    let len = t.chars().count();
    if !(2..=120).contains(&len) {
        return false;
    }
    if regex_like_filename(t) {
        return false;
    }
    let lower = t.to_ascii_lowercase();
    for prefix in [
        "img", "image", "screenshot", "screen", "shot", "pic", "photo", "figure", "fig",
    ] {
        // 자동 파일명 토큰(img, img_1234, screenshot 2024 …) 하나로 끝나면 제외.
        if let Some(rest) = lower.strip_prefix(prefix) {
            let rest = rest.trim_matches([' ', '_', '-']);
            let rest = rest.trim_end_matches(|c: char| c.is_ascii_digit() || c == ' ' || c == '_' || c == '-');
            if rest.is_empty() {
                return false;
            }
        }
    }
    true
}

/// 전체가 하나의 파일명(확장자로 끝)인지 — 간단 패턴.
fn regex_like_filename(t: &str) -> bool {
    let Some((stem, ext)) = t.rsplit_once('.') else {
        return false;
    };
    if !matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "heic" | "avif" | "tif" | "tiff"
    ) {
        return false;
    }
    !stem.is_empty()
        && stem
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '(' | ')' | '_' | '-' | '[' | ']'))
}

/// 표 캡션 문단 — SEQ Table 필드. 그림 캡션과 같은 구조.
fn table_caption_xml(alt: &str, n: u32) -> String {
    format!(
        concat!(
            "<w:p><w:pPr><w:pStyle w:val=\"Caption\"/><w:jc w:val=\"center\"/></w:pPr>",
            "<w:r><w:t xml:space=\"preserve\">표 </w:t></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>",
            "<w:r><w:instrText xml:space=\"preserve\"> SEQ Table \\* ARABIC </w:instrText></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
            "<w:r><w:t>{}</w:t></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>",
            "<w:r><w:t xml:space=\"preserve\"> — {}</w:t></w:r>",
            "</w:p>"
        ),
        n,
        esc(alt)
    )
}

/// 그림 캡션 문단 — SEQ Figure 필드(Word가 번호를 계속 매김) + 설명.
fn figure_caption_xml(alt: &str, n: u32) -> String {
    format!(
        concat!(
            "<w:p><w:pPr><w:pStyle w:val=\"Caption\"/><w:jc w:val=\"center\"/></w:pPr>",
            "<w:r><w:t xml:space=\"preserve\">그림 </w:t></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>",
            "<w:r><w:instrText xml:space=\"preserve\"> SEQ Figure \\* ARABIC </w:instrText></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
            "<w:r><w:t>{}</w:t></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>",
            "<w:r><w:t xml:space=\"preserve\"> — {}</w:t></w:r>",
            "</w:p>"
        ),
        n,
        esc(alt)
    )
}

/// 첫 페이지(표지) 머리글 — 비어 있음(titlePg가 쓰게 하는 짝).
fn header_first_xml() -> String {
    concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
        "<w:hdr xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
        "<w:p/>",
        "</w:hdr>"
    )
    .to_string()
}

/// 머리글 — 가운데 문서 제목(9pt 회색, PDF 머리글과 같은 톤).
fn header_xml(title: &str) -> String {
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<w:hdr xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
            "<w:p><w:pPr><w:jc w:val=\"center\"/>",
            "<w:pBdr><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"2\" w:color=\"D9DCE1\"/></w:pBdr>",
            "</w:pPr>",
            "<w:r><w:rPr><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/><w:color w:val=\"808080\"/></w:rPr>",
            "<w:t>{}</w:t></w:r></w:p></w:hdr>"
        ),
        esc(title)
    )
}

/// 바닥글 — 가운데 "현재 페이지 / 전체 페이지"(PAGE·NUMPAGES 필드, 9pt 회색).
/// 필드 결과값(1 등)은 Word가 열 때 다시 계산한다.
fn footer_xml() -> String {
    const RPR: &str = "<w:rPr><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/><w:color w:val=\"808080\"/></w:rPr>";
    let field = |instr: &str, shown: &str| {
        format!(
            "<w:r>{RPR}<w:fldChar w:fldCharType=\"begin\"/></w:r>\
<w:r>{RPR}<w:instrText xml:space=\"preserve\"> {instr} </w:instrText></w:r>\
<w:r>{RPR}<w:fldChar w:fldCharType=\"separate\"/></w:r>\
<w:r>{RPR}<w:t>{shown}</w:t></w:r>\
<w:r>{RPR}<w:fldChar w:fldCharType=\"end\"/></w:r>"
        )
    };
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<w:ftr xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
            "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr>",
            "{}",
            "<w:r>{RPR}<w:t xml:space=\"preserve\"> / </w:t></w:r>",
            "{}",
            "</w:p></w:ftr>"
        ),
        field("PAGE", "1"),
        field("NUMPAGES", "1"),
        RPR = RPR,
    )
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
            // 북마크(내부 앵커 링크 목적지) — 슬러그는 프런트와 같은 GitHub식.
            let text: String = node
                .children()
                .filter_map(|c| match &c.data.borrow().value {
                    NodeValue::Text(t) => Some(t.to_string()),
                    _ => None,
                })
                .collect();
            let slug = ctx.bookmark_slug(&text);
            let bm = format!(
                "<w:bookmarkStart w:id=\"B{slug}\" w:name=\"{slug}\"/><w:bookmarkEnd w:id=\"B{slug}\"/>"
            );
            let _ = writeln!(
                out,
                "<w:p><w:pPr><w:pStyle w:val=\"Heading{level}\"/></w:pPr>{bm}{runs}</w:p>"
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

/// 셀 안 텍스트 전체 수집(재귀 — 인라인 서식 안까지).
fn collect_text<'a>(node: &'a AstNode<'a>, out: &mut String) {
    match &node.data.borrow().value {
        NodeValue::Text(t) => out.push_str(t),
        _ => {
            for c in node.children() {
                collect_text(c, out);
            }
        }
    }
}

/// 표 헤더 키 — 프런트 tableKey.ts와 같은 규칙: 셀 텍스트에서 공백·강조
/// 마커 제거 후 \x1f 결합. 줄 이동·서식 변화에 불변한 식별자.
fn table_header_key<'a>(node: &'a AstNode<'a>) -> String {
    let mut cells: Vec<String> = Vec::new();
    if let Some(row) = node.children().next() {
        for cell in row.children() {
            let mut text = String::new();
            collect_text(cell, &mut text);
            let norm: String = text
                .chars()
                .filter(|c| !c.is_whitespace() && !matches!(c, '*' | '_' | '`' | '~'))
                .collect();
            cells.push(norm);
        }
    }
    cells.join("\u{1f}")
}

fn table<'a>(
    node: &'a AstNode<'a>,
    t: &NodeTable,
    ctx: &mut Ctx<'_>,
    out: &mut String,
) -> Result<(), DocxError> {
    let n_cols = t.num_columns;
    // 열 폭: 사이드카 지정이면 비율 반영, 아니면 균등(6in=8640 twip).
    let key = table_header_key(node);
    let custom = ctx
        .table_widths
        .get(&key)
        .filter(|w| w.len() >= 2 && w.iter().sum::<u32>() > 0);
    let col_tws: Vec<i64> = match custom {
        Some(w) => {
            let sum: f64 = w.iter().map(|&x| f64::from(x)).sum();
            w.iter().map(|&x| ((8640.0 * f64::from(x)) / sum).round() as i64).collect()
        }
        None => vec![8640 / n_cols.max(1) as i64; n_cols],
    };
    let col_tw = col_tws[0];
    let _ = write!(
        out,
        "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/>\
<w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>\
<w:top w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/><w:left w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/>\
<w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/><w:right w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/>\
<w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"B8BCC4\"/>\
</w:tblBorders>\
<w:tblCellMar>\
<w:top w:w=\"80\" w:type=\"dxa\"/><w:left w:w=\"120\" w:type=\"dxa\"/>\
<w:bottom w:w=\"80\" w:type=\"dxa\"/><w:right w:w=\"120\" w:type=\"dxa\"/>\
</w:tblCellMar></w:tblPr><w:tblGrid>"
    );
    for (i, tw) in col_tws.iter().enumerate() {
        let _ = write!(out, "<w:gridCol w:w=\"{tw}\"/>");
        let _ = i;
    }
    out.push_str("</w:tblGrid>");

    // 표 캡션(Pandoc 규약 ': 텍스트') — comrak가 파이프 없는 줄을 표의
    // 마지막 1셀 행으로 흡수하므로 여기서 뽑아낸다(원문 불변 — 해석만).
    let rows: Vec<&AstNode> = node.children().collect();
    let mut caption: Option<String> = None;
    let render_rows: &[&AstNode] = match rows.last() {
        Some(last) => {
            // 파이프 없는 ': 캡션' 줄이 마지막 행으로 흡수된 모양: 첫 셀만
            // 내용이 있고 ': '로 시작. (진짜 행 | : x | y | 와 구분 — 나머지
            // 셀이 비어 있어야만 캡션으로 본다.)
            let cells: Vec<&AstNode> = last.children().collect();
            let mut first = String::new();
            if let Some(c0) = cells.first() {
                collect_text(c0, &mut first);
            }
            let rest_empty = cells.iter().skip(1).all(|c| {
                let mut t = String::new();
                collect_text(c, &mut t);
                t.trim().is_empty()
            });
            match first.strip_prefix(": ") {
                Some(cap) if !cap.trim().is_empty() && rest_empty => {
                    caption = Some(cap.trim().to_string());
                    &rows[..rows.len() - 1]
                }
                _ => &rows[..],
            }
        }
        None => &rows[..],
    };

    let mut col_idx;
    let mut is_header;
    for row in render_rows {
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
                    "<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F3F5\"/>"
                } else {
                    ""
                };
                let bold = if is_header { "<w:b/>" } else { "" };
                // 헤더는 rPr b를 각 run에 넣을 수 없어 셀 수준 스타일로.
                let cell_tw = col_tws.get(col_idx).copied().unwrap_or(col_tw);
                let _ = write!(
                    out,
                    "<w:tc><w:tcPr>{shade}<w:tcW w:w=\"{cell_tw}\" w:type=\"dxa\"/></w:tcPr>\
<w:p><w:pPr>{jc}<w:rPr>{bold}</w:rPr></w:pPr>{runs}</w:p></w:tc>"
                );
                col_idx += 1;
            }
            out.push_str("</w:tr>");
        }
    }
    // 표 뒤 빈 문단(Word 관례) + 캡션(SEQ Table — Word가 번호 갱신).
    out.push_str("</w:tbl><w:p/>");
    if let Some(cap) = caption {
        ctx.tables += 1;
        out.push_str(&table_caption_xml(&cap, ctx.tables));
    }
    Ok(())
}

// — 인라인 —

fn plain_run(text: &str, style: &RunStyle) -> String {
    if text.is_empty() {
        return String::new();
    }
    // rpr(style): 굵게·기울임·취소·위첨자 등 인라인 서식 런 속성(각주 안
    // 인라인이 사라지던 회귀 수정 — 스타일이 무시돼선 안 된다).
    format!("<w:r>{}<w:t{}>{}</w:t></w:r>", rpr(style), PRESERVE, esc(text))
}

#[derive(Default)]
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


// — 각주(Word 네이티브) —


/// 마크다운에서 각주를 뽑아낸다: 정의 줄([\^라벨]: … + 들여쓰기 연속)은 제거,
/// 참조 [\^라벨]은 자리표시자(\u{E000}라벨\u{E000})로. 코드 펜스 안은 건드리지
/// 않는다. comrak이 [\^라벨]: 를 링크 참조 정의로 소비하므로 파싱 전에
/// 처리한다(정의 순서 = 문서 순).
fn extract_footnotes(markdown: &str) -> (String, Vec<(String, String)>) {
    let mut defs: Vec<(String, String)> = Vec::new();
    let mut out_lines: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut fence = "";
    let mut collecting: Option<(usize, String)> = None; // (defs 인덱스, 모으는 정의)
    for line in markdown.lines() {
        let t = line.trim_start();
        if let Some(c) = t.chars().next() {
            if (c == '`' || c == '~') && t.len() >= 3 && t.chars().all(|x| x == c) {
                if !in_fence {
                    in_fence = true;
                    fence = &t[..3];
                } else if &t[..3] == fence && t.chars().all(|x| x == c) {
                    in_fence = false;
                }
            }
        }
        if !in_fence {
            if let Some(rest) = t.strip_prefix("[^") {
                if let Some(close) = rest.find(']') {
                    let label = &rest[..close];
                    let after = &rest[close + 1..];
                    if !label.is_empty()
                        && !label.contains(char::is_whitespace)
                        && after.starts_with(':')
                    {
                        let body = after[1..].trim_start().to_string();
                        defs.push((label.to_string(), body));
                        collecting = Some((defs.len() - 1, String::new()));
                        continue;
                    }
                }
            }
            // 들여쓰기 연속 줄 — 모으는 정의에 붙인다.
            if let Some((idx, acc)) = collecting.as_mut() {
                if line.starts_with("    ") && !t.is_empty() {
                    acc.push('\n');
                    acc.push_str(t);
                    defs[*idx].1.push('\n');
                    defs[*idx].1.push_str(t);
                    continue;
                }
            }
            collecting = None;
        }
        out_lines.push(line.to_string());
    }
    // 참조 치환(펜스 밖 줄만 — 이미 줄 단위로 모았으니 다시 스캔).
    let labels: Vec<&str> = defs.iter().map(|(l, _)| l.as_str()).collect();
    let replaced: Vec<String> = out_lines
        .into_iter()
        .map(|mut line| {
            // 펜스 추적 재계산은 복잡 — 원본 순서와 같으므로 간단 펜스 검사.
            for label in &labels {
                let needle = format!("[^{label}]");
                let repl = format!("\u{E000}{label}\u{E000}");
                line = line.replace(&needle, &repl);
            }
            line
        })
        .collect();
    (replaced.join("\n"), defs)
}

/// 하이퍼링크 안 런들에 Hyperlink 글자 스타일 주입 — 이미 rPr가 있으면
/// 그 안 맨 앞에 rStyle을(rPr 첫 자리가 규격 순서), 없으면 rPr를 새로 만든다.
fn apply_hyperlink_style(runs: &str) -> String {
    runs.replace("<w:r><w:rPr>", "<w:r><w:rPr><w:rStyle w:val=\"Hyperlink\"/>")
        .replace("<w:r>", "<w:r><w:rPr><w:rStyle w:val=\"Hyperlink\"/></w:rPr>")
        .replace(
            "</w:rPr><w:rPr><w:rStyle w:val=\"Hyperlink\"/>",
            "<w:rStyle w:val=\"Hyperlink\"/></w:rPr>",
        )
}

/// 본문 문자열의 자리표시자(\u{E000}라벨\u{E000})를 footnoteReference로 치환.
/// 등록 안 된 라벨은 원문 [^라벨]로 복원(데이터 무손실).
fn resolve_footnote_refs(body: &str, ctx: &Ctx) -> String {
    const SEP: char = '\u{E000}';
    let sep_len = SEP.len_utf8();
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(i) = rest.find(SEP) {
        out.push_str(&rest[..i]);
        let after = &rest[i + sep_len..];
        match after.find(SEP) {
            Some(j) => {
                let label = &after[..j];
                match ctx.footnote_ids.get(label) {
                    Some(id) => out.push_str(&format!(
                        "<w:r><w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr><w:footnoteReference w:id=\"{id}\"/></w:r>"
                    )),
                    None => out.push_str(&format!("[^{label}]")),
                }
                rest = &after[j + sep_len..];
            }
            None => {
                out.push(SEP);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// word/footnotes.xml — 구분자(-1)·연속 구분자(0) + 정의(1..N).
fn footnotes_xml(ctx: &Ctx) -> String {
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:footnotes xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
<w:footnote w:type=\"separator\" w:id=\"-1\"><w:p><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>\
<w:footnote w:type=\"continuationSeparator\" w:id=\"0\"><w:p><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>",
    );
    for (i, runs) in ctx.footnotes.iter().enumerate() {
        let _ = write!(
            s,
            "<w:footnote w:id=\"{}\"><w:p><w:pPr><w:sz w:val=\"18\"/></w:pPr>{runs}</w:p></w:footnote>",
            i + 1
        );
    }
    s.push_str("</w:footnotes>");
    s
}



thread_local! {
    /// 문서 단위 형광펜 색 — export_docx 시작에 설정한다(text_run 계열이
    /// ctx를 받지 않는 자유 함수들이라 여기에 둔다).
    static HL_FILL: std::cell::RefCell<String> = std::cell::RefCell::new("FFF3A3".into());
}

fn set_hl_fill(hex: &str) {
    HL_FILL.with(|c| *c.borrow_mut() = hex.to_string());
}

fn hl_fill() -> String {
    HL_FILL.with(|c| c.borrow().clone())
}

/// 형광펜 런 — 노란 배경 shading(w:shd). 편집기·HTML의 ==하이라이트==와
/// 같은 의미(15차의 굵게 강등을 대체하는 Word 네이티브 표현).
fn highlight_run(text: &str, style: &RunStyle) -> String {
    let shd = format!(r#"<w:shd w:val="clear" w:color="auto" w:fill="{}"/>"#, hl_fill());
    let base = rpr(style);
    let rpr_with = if base.is_empty() {
        format!("<w:rPr>{shd}</w:rPr>")
    } else {
        // "</w:rPr>"를 떼고 shd를 끼운다.
        let inner = &base[..base.len() - "</w:rPr>".len()];
        format!("{inner}{shd}</w:rPr>")
    };
    format!("<w:r>{rpr_with}<w:t{}>{}</w:t></w:r>", PRESERVE, esc(text))
}

fn text_run(text: &str, style: &RunStyle) -> String {
    if text.is_empty() {
        return String::new();
    }
    // 각주 참조 [^라벨] → 자리표시자 런(문서 조립 뒤 치환). 하이라이트와
    // 겹치는 경우는 드물어 각각 독립 스캔.
    if text.contains("[^") {
        let mut out = String::new();
        let mut rest = text;
        while let Some(i) = rest.find("[^") {
            let after = &rest[i + 2..];
            match after.find(']') {
                Some(j) if j > 0 && !after[..j].contains(char::is_whitespace) => {
                    let label = &after[..j];
                    out.push_str(&highlight_text_run(&rest[..i], style));
                    out.push_str(&plain_run(
                        &format!("{FNSEP}{label}{FNSEP}", FNSEP = '\u{E000}'),
                        style,
                    ));
                    rest = &after[j + 1..];
                }
                _ => break,
            }
        }
        out.push_str(&highlight_text_run(rest, style));
        return out;
    }
    highlight_text_run(text, style)
}

fn highlight_text_run(text: &str, style: &RunStyle) -> String {
    if text.is_empty() {
        return String::new();
    }
    if !text.contains("==") {
        return plain_run(text, style);
    }
    // 텍스트 노드 안의 ==…== 를 shaded 런으로(노드를 가로지르는 하이라이트는
    // comrak가 이미 다른 인라인 노드로 쪼갠 경우 — v1에서는 순수 텍스트만).
    let mut out = String::new();
    let mut rest = text;
    while let Some(start) = rest.find("==") {
        match rest[start + 2..].find("==").map(|e| start + 2 + e) {
            Some(end)
                if !rest[start + 2..end].is_empty() && !rest[start + 2..end].contains('\n') =>
            {
                out.push_str(&plain_run(&rest[..start], style));
                out.push_str(&highlight_run(&rest[start + 2..end], style));
                rest = &rest[end + 2..];
            }
            _ => {
                // 닫는 짝 없음 — 여는 ==까지 일반 텍스트로 내보내고 계속.
                out.push_str(&plain_run(&rest[..start + 2], style));
                rest = &rest[start + 2..];
            }
        }
    }
    out.push_str(&plain_run(rest, style));
    out
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
            let mut runs = String::new();
            let s = RunStyle {
                italic: false,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, &mut runs, &s, _level)?;
            }
            // 내부 앵커(#슬러그)는 문서 내 북마크로 — 외부 URL만 관계를 쓴다.
            if let Some(anchor) = link.url.strip_prefix('#') {
                if !anchor.is_empty() {
                    let _ = write!(out, "<w:hyperlink w:anchor=\"{anchor}\">{}</w:hyperlink>", apply_hyperlink_style(&runs));
                    return Ok(());
                }
            }
            let id = ctx.add_hyperlink(&link.url);
            let _ = write!(out, "<w:hyperlink r:id=\"rIdH{id}\">{}</w:hyperlink>", apply_hyperlink_style(&runs));
        }
        NodeValue::Image(link) => {
            let alt: String = node
                .children()
                .map(|c| match &c.data.borrow().value {
                    NodeValue::Text(t) => t.to_string(),
                    _ => String::new(),
                })
                .collect();
            if let Some(drawing) = image_drawing(ctx, &link.url) {
                out.push_str(&drawing);
                // 캡션 후보 alt면 그림 캡션 문단(SEQ Figure — Word가 갱신).
                if caption_worthy(&alt) {
                    ctx.figures += 1;
                    out.push_str(&figure_caption_xml(&alt, ctx.figures));
                }
            } else {
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
    // 사이드카 폭(%) — 편집기에서 드래그한 값과 동일하게 축소.
    let pct = ctx.images.width(url).unwrap_or(100).clamp(5, 100) as f64 / 100.0;
    let lower = url.to_ascii_lowercase();
    if lower.ends_with(".svg") || lower.contains(".svg?") {
        let svg = ctx.images.read(url)?;
        let svg = String::from_utf8(svg).ok()?;
        let drawing = svg_to_drawingml(&svg, (PAGE_TEXT_WIDTH_EMU as f64 * pct) as i64).ok()?;
        return Some(format!("<w:p>{drawing}</w:p>"));
    }
    let bytes = ctx.images.read(url)?;
    let ext = detect_image(&bytes)?;
    // 크기: 이미지 헤더에서 추출, 실패 시 4x3in.
    let (w_px, h_px) = image_dimensions(&bytes).unwrap_or((384, 288));
    let scale = (PAGE_TEXT_WIDTH_EMU as f64 / (w_px as f64 * 9525.0)).min(1.0) * pct;
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
    opts: &DocxExportOptions<'_>,
    style: Option<(&str, f64, f64, bool, String, String)>,
) -> Result<(), DocxError> {
    let (page_numbers, title, author, toc, header_title) =
        (opts.page_numbers, opts.title, opts.author, opts.toc, opts.header_title);
    let file = std::fs::File::create(out)?;
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let add = |zip: &mut zip::ZipWriter<std::fs::File>, name: &str, data: &str| -> Result<(), DocxError> {
        zip.start_file(name, opts)?;
        Ok(zip.write_all(data.as_bytes())?)
    };

    let has_footnotes = !ctx.footnotes.is_empty();
    add(
        &mut zip,
        "[Content_Types].xml",
        &content_types(ctx, page_numbers, header_title.is_some()),
    )?;
    add(&mut zip, "_rels/.rels", RELS_ROOT)?;
    add(&mut zip, "word/document.xml", &document(body))?;
    if has_footnotes {
        add(&mut zip, "word/footnotes.xml", &footnotes_xml(ctx))?;
    }
    if page_numbers {
        add(&mut zip, "word/footer1.xml", &footer_xml())?;
    }
    if let Some(ht) = header_title {
        add(&mut zip, "word/header1.xml", &header_xml(ht))?;
        add(&mut zip, "word/headerFirst.xml", &header_first_xml())?;
    }
    add(
        &mut zip,
        "word/_rels/document.xml.rels",
        &document_rels(ctx, page_numbers, header_title.is_some()),
    )?;
    add(&mut zip, "word/styles.xml", &styles_xml(style))?;
    add(&mut zip, "word/numbering.xml", NUMBERING)?;
    add(&mut zip, "word/settings.xml", &settings_xml(toc))?;
    add(&mut zip, "docProps/core.xml", &core_props(title, author))?;
    add(&mut zip, "docProps/app.xml", APP)?;

    for (name, bytes) in &ctx.media {
        zip.start_file(format!("word/{name}"), opts)?;
        zip.write_all(bytes)?;
    }
    zip.finish()?;
    Ok(())
}

fn content_types(ctx: &Ctx, page_numbers: bool, has_header: bool) -> String {
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
            "{footnote_ct}",
            "<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>",
            "<Override PartName=\"/word/settings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml\"/>",
            "{footer_ct}",
            "{header_ct}",
            "<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>",
            "<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>",
            "</Types>",
        ),
        media = media_defaults,
        footer_ct = if page_numbers {
            "<Override PartName=\"/word/footer1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml\"/>"
        } else {
            ""
        },
        header_ct = if has_header {
            "<Override PartName=\"/word/header1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml\"/>\
<Override PartName=\"/word/headerFirst.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml\"/>"
        } else {
            ""
        },
        footnote_ct = if ctx.footnotes.is_empty() {
            String::new()
        } else {
            "<Override PartName=\"/word/footnotes.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml\"/>".to_string()
        },
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

fn document_rels(ctx: &Ctx, page_numbers: bool, has_header: bool) -> String {
    let mut s = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyle" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>"#,
    );
    if page_numbers {
        let _ = write!(
            s,
            "<Relationship Id=\"rIdFooter\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer\" Target=\"footer1.xml\"/>"
        );
    }
    if has_header {
        let _ = write!(
            s,
            "<Relationship Id=\"rIdHeader\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/header\" Target=\"header1.xml\"/>\
<Relationship Id=\"rIdHeaderFirst\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/header\" Target=\"headerFirst.xml\"/>"
        );
    }
    if !ctx.footnotes.is_empty() {
        let _ = write!(
            s,
            "<Relationship Id=\"rIdFootnotes\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes\" Target=\"footnotes.xml\"/>"
        );
    }
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
fn styles_xml(style: Option<(&str, f64, f64, bool, String, String)>) -> String {
    let (ascii, east_asia, half_points, line, indent, accent, align) = match style {
        Some((font, pt, lh, fi, ac, al)) => {
            let (ascii, east_asia) = match font {
                "serif" => ("Georgia", "AppleMyungjo"),
                "mono" => ("Menlo", "Apple SD Gothic Neo"),
                "round" => ("Helvetica Neue", "Apple SD Gothic Neo"),
                _ => ("-apple-system", "Apple SD Gothic Neo"),
            };
            (
                ascii,
                east_asia,
                (pt * 2.0).round() as i64,
                if lh > 0.0 { lh } else { 1.15 },
                fi,
                ac.to_string(),
                al.to_string(),
            )
        }
        None => (
            "-apple-system",
            "Apple SD Gothic Neo",
            22i64,
            1.15f64,
            false,
            String::new(),
            String::new(),
        ),
    };
    let heading_scale = |mult: f64, base: i64| ((base as f64 * mult).round() as i64).to_string();
    let base = half_points;
    let h1 = heading_scale(1.45, base);
    let h2 = heading_scale(1.24, base);
    let h3 = heading_scale(1.12, base);
    // 행간(240 = 단일)과 첫 줄 들여쓰기(1.25em ≈ 폰트 크기의 1.25배 twip).
    let line_rule = format!("{:.0}", (line * 240.0).round());
    let indent_tw = format!("{:.0}", (base as f64 / 2.0) * 1.25 * 20.0);
    let mut para_extra = if indent {
        format!("<w:ind w:firstLine=\"{indent_tw}\"/>")
    } else {
        String::new()
    };
    // 문단 정렬(jc) — Word 문단 정렬과 같은 값.
    if !align.is_empty() && align != "left" {
        para_extra.push_str(&format!("<w:jc w:val=\"{align}\"/>"));
    }
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
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/>
<w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr>
<w:rPr><w:i/><w:color w:val="59636E"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/>
<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/>
<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TOC2"><w:name w:val="toc 2"/>
<w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="240"/><w:spacing w:after="40"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TOC3"><w:name w:val="toc 3"/>
<w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="480"/><w:spacing w:after="40"/></w:pPr></w:style>
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

/// settings.xml — 목차(TOC)가 있으면 열 때 필드를 갱신하게 한다(updateFields).
fn settings_xml(toc: bool) -> String {
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<w:settings xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" ",
            "xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\">",
            "<w:zoom w:percent=\"100\"/><w:defaultTabStop w:val=\"720\"/>",
            "{}",
            "<w:mathPr><m:mathFont m:val=\"Cambria Math\"/><m:brkBin m:val=\"before\"/>",
            "<m:brkBinSub m:val=\"--\"/><m:smallFrac m:val=\"0\"/><m:dispDef/>",
            "<m:lMargin m:val=\"0\"/> <m:rMargin m:val=\"0\"/><m:defJc m:val=\"centerGroup\"/>",
            "<m:wrapIndent m:val=\"1440\"/><m:intLim m:val=\"subSup\"/><m:naryLim m:val=\"undOvr\"/></w:mathPr>",
            "</w:settings>"
        ),
        if toc {
            "<w:updateFields w:val=\"true\"/>"
        } else {
            ""
        }
    )
}

/// core.xml — 프런트매터 메타(있으면)를 문서 속성으로. 없으면 앱 기본값.
fn core_props(title: Option<&str>, author: Option<&str>) -> String {
    let t = esc(title.filter(|s| !s.is_empty()).unwrap_or("IYAGI Markdown 문서"));
    let a = esc(author.filter(|s| !s.is_empty()).unwrap_or("IYAGI Markdown"));
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" ",
            "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" ",
            "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">",
            "<dc:title>{}</dc:title>",
            "<dc:creator>{}</dc:creator>",
            "<cp:lastModifiedBy>IYAGI Markdown</cp:lastModifiedBy>",
            "</cp:coreProperties>",
        ),
        t, a
    )
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
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out).unwrap();
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
    fn resolve_footnote_refs_unit() {
        let ctx = Ctx {
            math: &HashMap::new(),
            diagrams: &HashMap::new(),
            images: &ImageSource::new(String::new()),
            media: Vec::new(),
            hyperlinks: Vec::new(),
            next_doc_id: 100,
            footnotes: vec!["DEF".into()],
            footnote_ids: [("a".to_string(), 1usize)].into_iter().collect(),
            slug_seen: std::collections::HashMap::new(),
            table_widths: HashMap::new(),
            figures: 0,
            tables: 0,
        };
        let body = "x\u{E000}a\u{E000}y";
        let out = resolve_footnote_refs(body, &ctx);
        assert!(out.contains("<w:footnoteReference w:id=\"1\"/>"));
        assert!(!out.contains("\u{E000}"));
    }

    #[test]
    fn anchor_links_and_heading_bookmarks() {
        let md = "# 개요\n\n[설치로](#설치) 이동.\n\n## 설치\n\n## 설치\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("anchor");
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        let read = |zip: &mut zip::ZipArchive<std::io::Cursor<&Vec<u8>>>, name: &str| {
            let mut s = String::new();
            use std::io::Read;
            zip.by_name(name).unwrap().read_to_string(&mut s).unwrap();
            s
        };
        let doc = read(&mut zip, "word/document.xml");
        // 북마크: 첫 설치는 이름 그대로, 둘째는 -1(GitHub식 — 프런트 toc와 동일).
        assert!(doc.contains(r#"<w:bookmarkStart w:id="B설치" w:name="설치"/>"#));
        assert!(doc.contains(r#"w:name="설치-1""#));
        // 내부 링크는 관계가 아니라 anchor 속성으로.
        assert!(doc.contains(r#"<w:hyperlink w:anchor="설치">"#));
        assert!(!doc.contains("rIdH"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn footnotes_become_native_word_footnotes() {
        let md = "본문입니다[^a]. 각주 참조 뒤 문장.\n\n[^a]: 각주 정의 **내용**.\n\n뒤 문단.\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("fn");
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        let read = |zip: &mut zip::ZipArchive<std::io::Cursor<&Vec<u8>>>, name: &str| {
            let mut s = String::new();
            use std::io::Read;
            zip.by_name(name).unwrap().read_to_string(&mut s).unwrap();
            s
        };
        let doc = read(&mut zip, "word/document.xml");
        // 참조가 네이티브 각주 표시로(위첨자 + footnoteReference id 1).
        assert!(doc.contains("<w:footnoteReference w:id=\"1\"/>"));
        assert!(doc.contains("superscript"));
        // 정의는 본문에 없다.
        assert!(!doc.contains("[^a]:"));
        assert!(doc.contains("뒤 문단"));
        let fns = read(&mut zip, "word/footnotes.xml");
        assert!(fns.contains("각주 정의"));
        assert!(fns.contains("<w:b/>")); // 정의 안 굵게 등 인라인 서식 유지
        // 관계·콘텐츠 타입.
        let rels = read(&mut zip, "word/_rels/document.xml.rels");
        assert!(rels.contains("footnotes.xml"));
        let ct = read(&mut zip, "[Content_Types].xml");
        assert!(ct.contains("footnotes+xml"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn highlight_becomes_shading() {
        let md = "서론 ==여기가 핵심== 결론. 짝 없는 == 는 그대로.\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("hl");
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        let doc = {
            let mut s = String::new();
            use std::io::Read;
            zip.by_name("word/document.xml").unwrap().read_to_string(&mut s).unwrap();
            s
        };
        assert!(doc.contains(r#"w:fill="FFF3A3""#));
        assert!(doc.contains("여기가 핵심"));
        // 닫는 짝이 없는 == 는 평문으로 남는다(텍스트 소실 없음).
        assert!(doc.contains("그대로"));
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
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out).unwrap();
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
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out).unwrap();
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
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out).unwrap();
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

    #[test]
    fn image_width_pct_shrinks_extent() {
        // 100x40 PNG — 폭 지정 없으면 페이지 폭(6in)에 맞춰 확대되는 크기.
        let png: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 100, 0, 0, 0, 40, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0A, 0x49,
            0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0D, 0x0A, 0x2D, 0xB4, 0,
            0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let dir = std::env::temp_dir().join(format!("md-export-docx-w-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.png"), &png).unwrap();
        let md = "![](a.png)\n";

        let read_doc = |widths: Option<u32>| -> (String, String) {
            let math = HashMap::new();
            let diagrams = HashMap::new();
            let mut images = ImageSource::new(dir.to_string_lossy().into_owned());
            if let Some(p) = widths {
                images.set_widths([("a.png".to_string(), p)].into_iter().collect());
            }
            let out = tmp("imgw");
            export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out).unwrap();
            let bytes = std::fs::read(&out).unwrap();
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
            use std::io::Read;
            let mut doc = String::new();
            zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
            let _ = std::fs::remove_file(&out);
            (doc, String::new())
        };

        let (full, _) = read_doc(None);
        let (half, _) = read_doc(Some(50));
        let ext_of = |doc: &str| -> i64 {
            let m = doc.split("cx=\"").nth(1).unwrap().split('"').next().unwrap();
            m.parse().unwrap()
        };
        let f = ext_of(&full);
        let h = ext_of(&half);
        assert!(f > 0);
        // 50% 지정이면 폭이 정확히 절반(반올림 ±1 EMU).
        assert!((f as f64 / 2.0 - h as f64).abs() <= 1.0, "full={f} half={h}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn table_width_pct_writes_grid() {
        let md = "| 이름 | 값 |\n|---|---|\n| a | 1 |\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let mut widths: HashMap<String, Vec<u32>> = HashMap::new();
        widths.insert("이름\u{1f}값".to_string(), vec![100, 300]);
        let out = tmp("tblw");
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &widths, title: None, author: None, toc: false, header_title: None, highlight: None }, &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        // 비율 1:3 → 8640을 2160/6480으로 분할.
        assert!(doc.contains("<w:gridCol w:w=\"2160\"/>"));
        assert!(doc.contains("<w:gridCol w:w=\"6480\"/>"));
        assert!(doc.contains("<w:tcW w:w=\"2160\""));
        assert!(doc.contains("<w:tcW w:w=\"6480\""));
        // 지정 없는 표는 균등(4320).
        let out2 = tmp("tblw-even");
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out2).unwrap();
        let bytes2 = std::fs::read(&out2).unwrap();
        let mut z2 = zip::ZipArchive::new(std::io::Cursor::new(&bytes2)).unwrap();
        let mut doc2 = String::new();
        z2.by_name("word/document.xml").unwrap().read_to_string(&mut doc2).unwrap();
        assert!(doc2.contains("<w:gridCol w:w=\"4320\"/>"));
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&out2);
    }

    #[test]
    fn table_caption_seq_and_consume() {
        let md = "| a | b |\n|---|---|\n| 1 | 2 |\n: 분기 결과 요약\n\n본문 계속\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("tblcap");
        export_docx(
            md,
            &DocxExportOptions {
                math: &math,
                diagrams: &diagrams,
                images: &images,
                style: None,
                page_numbers: false,
                table_widths: &HashMap::new(),
                title: None,
                author: None,
                toc: false,
                header_title: None,
                highlight: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert!(doc.contains(" SEQ Table \\* ARABIC "));
        assert!(doc.contains(" — 분기 결과 요약"));
        // 캡션 텍스트는 정확히 한 번(: 접두는 떼고 캡션으로만).
        assert_eq!(doc.matches("분기 결과 요약").count(), 1);
        assert!(doc.contains("본문 계속"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn highlight_color_fill() {
        let md = "==강조== 일반\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let build = |hl: Option<&str>| {
            let out = tmp(if hl.is_some() { "hl-color" } else { "hl-def" });
            export_docx(
                md,
                &DocxExportOptions {
                    math: &math,
                    diagrams: &diagrams,
                    images: &images,
                    style: None,
                    page_numbers: false,
                    table_widths: &HashMap::new(),
                    title: None,
                    author: None,
                    toc: false,
                    header_title: None,
                    highlight: hl,
                },
                &out,
            )
            .unwrap();
            let bytes = std::fs::read(&out).unwrap();
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
            use std::io::Read;
            let mut doc = String::new();
            zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
            let _ = std::fs::remove_file(&out);
            doc
        };
        let colored = build(Some("FFB3C1"));
        assert!(colored.contains(r#"w:fill="FFB3C1""#));
        let def = build(None);
        assert!(def.contains(r#"w:fill="FFF3A3""#));
    }

    #[test]
    fn hyperlink_runs_carry_style() {
        let md = "[링크 텍스트](https://x.y)와 [**굵게 링크**](https://a.b)\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("hlink");
        export_docx(
            md,
            &DocxExportOptions {
                math: &math,
                diagrams: &diagrams,
                images: &images,
                style: None,
                page_numbers: false,
                table_widths: &HashMap::new(),
                title: None,
                author: None,
                toc: false,
                header_title: None,
                highlight: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        // 모든 하이퍼링크 런에 rStyle Hyperlink — 굵게 런(rPr 기존)도 겹침 없이.
        assert!(doc.matches("w:rStyle w:val=\"Hyperlink\"").count() >= 3);
        assert!(!doc.contains("</w:rPr><w:rPr>"), "rPr 중복 없음");
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn figure_captions_seq_and_guards() {
        let png: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 0x0A, 0x49,
            0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0D, 0x0A, 0x2D, 0xB4, 0,
            0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let dir = std::env::temp_dir().join(format!("md-export-fig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.png"), &png).unwrap();
        std::fs::write(dir.join("b.png"), &png).unwrap();
        let md = "![실험 설정도](a.png)\n\n![screenshot.png](b.png)\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(dir.to_string_lossy().into_owned());
        let out = tmp("figcap");
        export_docx(
            md,
            &DocxExportOptions {
                math: &math,
                diagrams: &diagrams,
                images: &images,
                style: None,
                page_numbers: false,
                table_widths: &HashMap::new(),
                title: None,
                author: None,
                toc: false,
                header_title: None,
                highlight: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        // 캡션 후보만: SEQ 필드 + 설명, 번호 1.
        assert!(doc.contains(" SEQ Figure \\* ARABIC "));
        assert!(doc.contains("그림 </w:t>"));
        assert!(doc.contains(" — 실험 설정도"));
        assert_eq!(doc.matches("SEQ Figure").count(), 1); // 파일명 alt는 제외
        let mut styles = String::new();
        zip.by_name("word/styles.xml").unwrap().read_to_string(&mut styles).unwrap();
        assert!(styles.contains("\"caption\""));
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn header_title_wires_part_ref_rels_ct() {
        let md = "# 문서\n\n본문.\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let build = |header: Option<&str>, tag: &str| {
            let out = tmp(tag);
            export_docx(
                md,
                &DocxExportOptions {
                    math: &math,
                    diagrams: &diagrams,
                    images: &images,
                    style: None,
                    page_numbers: false,
                    table_widths: &HashMap::new(),
                    title: None,
                    author: None,
                    toc: false,
                    highlight: None,
                    header_title: header,
                },
                &out,
            )
            .unwrap();
            let bytes = std::fs::read(&out).unwrap();
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
            use std::io::Read;
            let entry = |zip: &mut zip::ZipArchive<std::io::Cursor<&Vec<u8>>>, name: &str| {
                match zip.by_name(name) {
                    Ok(mut z) => {
                        let mut s = String::new();
                        z.read_to_string(&mut s).unwrap();
                        s
                    }
                    Err(_) => String::new(),
                }
            };
            let hdr = zip.by_name("word/header1.xml").is_ok();
            let hdr_first = zip.by_name("word/headerFirst.xml").is_ok();
            let doc = entry(&mut zip, "word/document.xml");
            let rels = entry(&mut zip, "word/_rels/document.xml.rels");
            let ct = entry(&mut zip, "[Content_Types].xml");
            let _ = std::fs::remove_file(&out);
            (doc, hdr, hdr_first, rels, ct)
        };
        // 켬 — 파트·참조·관계·콘텐츠타입.
        let (doc, hdr, hdr_first, rels, ct) = build(Some("보고서 <초안>"), "hdr2");
        assert!(hdr);
        assert!(hdr_first); // 표지용 빈 머리글
        assert!(doc.contains("<w:titlePg/>")); // 1쪽 다르게
        assert!(doc.contains("<w:headerReference w:type=\"default\" r:id=\"rIdHeader\"/>"));
        let hpos = doc.find("headerReference").unwrap();
        let pg = doc.find("<w:pgSz").unwrap();
        assert!(hpos < pg); // 규격 순서: 참조가 pgSz 앞
        assert!(rels.contains("Id=\"rIdHeader\"") && rels.contains("Target=\"header1.xml\""));
        assert!(ct.contains("/word/header1.xml"));
        // 끔 — 파트 없음·참조 없음.
        let (doc2, hdr2, _, rels2, ct2) = build(None, "hdr-off");
        assert!(!hdr2);
        assert!(!doc2.contains("headerReference"));
        assert!(!rels2.contains("rIdHeader"));
        assert!(!ct2.contains("header1.xml"));
    }

    #[test]
    fn toc_field_and_update_fields_setting() {
        let md = "# 서론\n\n본문.\n\n## 세부\n\n더.\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let build = |toc: bool, tag: &str| {
            let out = tmp(tag);
            export_docx(
                md,
                &DocxExportOptions {
                    math: &math,
                    diagrams: &diagrams,
                    images: &images,
                    style: None,
                    page_numbers: false,
                    table_widths: &HashMap::new(),
                    title: None,
                    author: None,
                    toc,
                    header_title: None,
                    highlight: None,
                },
                &out,
            )
            .unwrap();
            let bytes = std::fs::read(&out).unwrap();
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
            use std::io::Read;
            let mut doc = String::new();
            zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
            let mut settings = String::new();
            zip.by_name("word/settings.xml").unwrap().read_to_string(&mut settings).unwrap();
            let mut styles = String::new();
            zip.by_name("word/styles.xml").unwrap().read_to_string(&mut styles).unwrap();
            let _ = std::fs::remove_file(&out);
            (doc, settings, styles)
        };
        let (doc, settings, styles) = build(true, "toc");
        assert!(doc.contains("docPartGallery w:val=\"Table of Contents\""));
        assert!(doc.contains(" TOC \\o \"1-3\" \\h \\z \\u "));
        assert!(doc.contains("w:dirty=\"true\""));
        // 문서 첫머리(본문 제목 전)에 온다.
        let toc_at = doc.find("docPartGallery").unwrap();
        let h1_at = doc.find("서론").unwrap();
        assert!(toc_at < h1_at);
        // updateFields 켜짐 + TOC 스타일.
        assert!(settings.contains("<w:updateFields w:val=\"true\"/>"));
        assert!(styles.contains("TOCHeading"));
        assert!(styles.contains("\"toc 2\""));
        // 끄면 없다.
        let (doc2, settings2, _) = build(false, "toc-off");
        assert!(!doc2.contains("docPartGallery"));
        assert!(!settings2.contains("updateFields"));
    }

    #[test]
    fn core_props_from_frontmatter_meta() {
        let md = "---\ntitle: 보고서 <초안>\nauthor: 홍길동\n---\n\n# 본문\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("meta");
        export_docx(
            md,
            &DocxExportOptions {
                math: &math,
                diagrams: &diagrams,
                images: &images,
                style: None,
                page_numbers: false,
                table_widths: &HashMap::new(),
                title: Some("보고서 <초안>"),
                author: Some("홍길동"),
                toc: false,
                header_title: None,
                highlight: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut core = String::new();
        zip.by_name("docProps/core.xml").unwrap().read_to_string(&mut core).unwrap();
        assert!(core.contains("<dc:title>보고서 &lt;초안&gt;</dc:title>"));
        assert!(core.contains("<dc:creator>홍길동</dc:creator>"));
        // 없으면 앱 기본값.
        let out2 = tmp("meta-def");
        export_docx(
            "# 본문\n",
            &DocxExportOptions {
                math: &math,
                diagrams: &diagrams,
                images: &images,
                style: None,
                page_numbers: false,
                table_widths: &HashMap::new(),
                title: None,
                author: None,
                toc: false,
                header_title: None,
                highlight: None,
            },
            &out2,
        )
        .unwrap();
        let bytes2 = std::fs::read(&out2).unwrap();
        let mut z2 = zip::ZipArchive::new(std::io::Cursor::new(&bytes2)).unwrap();
        let mut core2 = String::new();
        z2.by_name("docProps/core.xml").unwrap().read_to_string(&mut core2).unwrap();
        assert!(core2.contains("<dc:title>IYAGI Markdown 문서</dc:title>"));
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&out2);
    }

    #[test]
    fn page_numbers_footer_wired() {
        let md = "# 문서\n\n본문.\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("footer");
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: true, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        use std::io::Read;
        // 바닥글 파트 + 필드 명령.
        let mut ftr = String::new();
        zip.by_name("word/footer1.xml").unwrap().read_to_string(&mut ftr).unwrap();
        assert!(ftr.contains(" PAGE "));
        assert!(ftr.contains(" NUMPAGES "));
        assert!(ftr.contains("<w:jc w:val=\"center\"/>"));
        // 문서 섹션 → 바닥글 참조.
        let mut doc = String::new();
        zip.by_name("word/document.xml").unwrap().read_to_string(&mut doc).unwrap();
        assert!(doc.contains("<w:footerReference w:type=\"default\" r:id=\"rIdFooter\"/>"));
        // 관계·콘텐츠 타입.
        let mut rels = String::new();
        zip.by_name("word/_rels/document.xml.rels").unwrap().read_to_string(&mut rels).unwrap();
        assert!(rels.contains("Id=\"rIdFooter\"") && rels.contains("Target=\"footer1.xml\""));
        let mut ct = String::new();
        zip.by_name("[Content_Types].xml").unwrap().read_to_string(&mut ct).unwrap();
        assert!(ct.contains("/word/footer1.xml"));
        // 끄면 아예 없다.
        let out2 = tmp("footer-off");
        export_docx(md, &DocxExportOptions { math: &math, diagrams: &diagrams, images: &images, style: None, page_numbers: false, table_widths: &HashMap::new(), title: None, author: None, toc: false, header_title: None, highlight: None }, &out2).unwrap();
        let bytes2 = std::fs::read(&out2).unwrap();
        let z2 = zip::ZipArchive::new(std::io::Cursor::new(&bytes2)).unwrap();
        assert!(z2.file_names().filter_map(|n| n.ok()).all(|n| n != "word/footer1.xml"));
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&out2);
    }

}
