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

use crate::docx_comments::DocxComments;
use crate::docx_lists::{DocxLists, ListInstance};
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
    #[error(transparent)]
    AtomicWrite(#[from] md_core::io::DocError),
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
    next_doc_id: u32,
    /// Parser-assigned footnote ID and complete rendered block content.
    footnotes: Vec<(u32, String)>,
    in_footnote: bool,
    /// 문서별 표 열 폭(px) — 헤더 내용 키(사이드카).
    table_widths: std::collections::HashMap<String, Vec<u32>>,
    /// 캡션 라벨 언어("ko"/"en") — 목차 필드 제목과 같은 규칙.
    lang: &'a str,
    /// 그림 캡션 번호(SEQ 초기값 — Word가 갱신).
    figures: u32,
    /// 표 캡션 번호(SEQ Table).
    tables: u32,
    /// Multiple source-line comments claimed by rendered blocks.
    comments: DocxComments,
    lists: DocxLists,
    /// Heading source line → reserved slug, before rendering nested inline runs.
    heading_slugs: HashMap<usize, String>,
    next_bookmark_id: u32,
    /// 서지 정의 줄 → 아직 연결하지 않은 북마크 키.
    cite_lines: std::collections::HashMap<u32, String>,
}

impl<'a> Ctx<'a> {
    fn bookmark_xml(&mut self, name: &str) -> String {
        let id = self.next_bookmark_id;
        self.next_bookmark_id += 1;
        let name = esc(name);
        format!("<w:bookmarkStart w:id=\"{id}\" w:name=\"{name}\"/><w:bookmarkEnd w:id=\"{id}\"/>")
    }

    fn add_media(&mut self, bytes: Vec<u8>, ext: &str) -> (String, usize) {
        // Package relationship IDs are independent of drawing IDs: SVG and
        // Mermaid drawings do not add a media part.
        let relationship_id = self.media.len() + 1;
        let name = format!("media/image{relationship_id}.{ext}");
        self.media.push((name.clone(), bytes));
        (name, relationship_id)
    }

    fn add_hyperlink(&mut self, url: &str) -> usize {
        if let Some(i) = self.hyperlinks.iter().position(|u| u == url) {
            return i + 1;
        }
        self.hyperlinks.push(url.to_string());
        self.hyperlinks.len()
    }

    fn next_id(&mut self) -> u32 {
        self.next_doc_id += 1;
        self.next_doc_id
    }
}

/// Recover raw inline source before applying citation or other display rewrites.
fn heading_title<'a>(node: &'a AstNode<'a>, lines: &[&str]) -> Result<String, DocxError> {
    let mut title = String::new();
    if let (Some(first), Some(last)) = (node.first_child(), node.last_child()) {
        let start = first.data.borrow().sourcepos.start;
        let end = last.data.borrow().sourcepos.end;
        let invalid = || DocxError::Build("Could not locate heading source text".into());
        let first_line = start.line.checked_sub(1).ok_or_else(invalid)?;
        let rows = lines.get(first_line..end.line).ok_or_else(invalid)?;
        let quotes = node
            .ancestors()
            .filter(|ancestor| {
                matches!(
                    ancestor.data.borrow().value,
                    NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_)
                )
            })
            .count();
        for (index, row) in rows.iter().enumerate() {
            let from = if index == 0 {
                start.column.checked_sub(1).ok_or_else(invalid)?
            } else {
                0
            };
            let to = if index + 1 == rows.len() {
                end.column
            } else {
                row.len()
            };
            let mut part = row.get(from..to).ok_or_else(invalid)?.trim();
            if index > 0 {
                for _ in 0..quotes {
                    if let Some(rest) = part.strip_prefix('>') {
                        part = rest.trim_start();
                    } else {
                        break;
                    }
                }
            }
            if index > 0 {
                title.push('\n');
            }
            title.push_str(part);
        }
    }
    Ok(title.trim().to_string())
}

/// Reserve body headings first, then rendered notes in reference order. Unused
/// footnote definitions must neither consume suffixes nor become link targets.
fn heading_anchors<'a>(
    root: &'a AstNode<'a>,
    source: &str,
    original_root: &'a AstNode<'a>,
    original_source: &str,
) -> Result<HashMap<usize, String>, DocxError> {
    let original_lines: Vec<_> = original_source.split('\n').collect();
    let mut original_titles = HashMap::new();
    for node in original_root.descendants() {
        if matches!(node.data.borrow().value, NodeValue::Heading(_)) {
            original_titles.insert(
                node.data.borrow().sourcepos.start.line,
                heading_title(node, &original_lines)?,
            );
        }
    }
    let note_ids: HashMap<String, u32> = root
        .descendants()
        .filter_map(|node| match &node.data.borrow().value {
            NodeValue::FootnoteReference(reference) => Some((reference.name.clone(), reference.ix)),
            _ => None,
        })
        .collect();
    let mut headings = Vec::new();
    for node in root.descendants() {
        if !matches!(node.data.borrow().value, NodeValue::Heading(_)) {
            continue;
        }
        let line = node.data.borrow().sourcepos.start.line;
        let definition = node.ancestors().find(|ancestor| {
            matches!(
                ancestor.data.borrow().value,
                NodeValue::FootnoteDefinition(_)
            )
        });
        let note_id = if let Some(definition) = definition {
            let data = definition.data.borrow();
            let NodeValue::FootnoteDefinition(note) = &data.value else {
                unreachable!()
            };
            if note.total_references == 0 {
                continue;
            }
            let Some(id) = note_ids.get(&note.name) else {
                continue;
            };
            *id
        } else {
            0
        };
        headings.push((note_id, line, node));
    }
    headings.sort_by_key(|(note_id, line, _)| (*note_id, *line));
    let lines: Vec<_> = source.split('\n').collect();
    let mut slugs = md_core::links::HeadingSlugs::default();
    let mut anchors = HashMap::new();
    for (_, line, node) in headings {
        // Preprocessing preserves source lines. Newly created headings (e.g. an
        // uncited bibliography entry beginning with '#') use their rendered source.
        let title = match original_titles.get(&line) {
            Some(title) => title.clone(),
            None => heading_title(node, &lines)?,
        };
        anchors.insert(line, slugs.allocate(&title));
    }
    Ok(anchors)
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
    /// 그림 목차(TOC \c Figure) — SEQ 캡션 기반.
    pub lof: bool,
    /// 표 목차(TOC \c Table).
    pub lot: bool,
    /// 머리글 문서 제목(Some이면 매 페이지 상단, PDF와 같은 관례).
    pub header_title: Option<&'a str>,
    /// 형광펜 색(RRGGBB — 없으면 기본 노랑).
    pub highlight: Option<&'a str>,
    /// 문서 메모(줄 앵커 — 편집기 사이드카)를 Word 원생 메모로 내보냄.
    pub comments: &'a [(u32, String)],
    /// 목차 라벨 언어("ko"/"en") — 필드 제목 현지화.
    pub front_lang: &'a str,
    /// 다단(1~3, 0·1=1단) — sectPr w:cols.
    pub columns: u32,
    /// 바닥글 자유 텍스트(프런트매터 footer:) — 쪽번호와 함께 footer1.xml.
    pub footer_text: Option<&'a str>,
}

/// 진입점: 마크다운 → .docx 파일.
pub fn export_docx(
    markdown: &str,
    opts: &DocxExportOptions<'_>,
    out: &Path,
) -> Result<(), DocxError> {
    let DocxExportOptions {
        math,
        diagrams,
        images,
        style,
        page_numbers,
        table_widths,
        toc,
        lof,
        lot,
        header_title,
        highlight,
        comments,
        front_lang,
        columns,
        footer_text,
        ..
    } = opts;
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.math_dollars = true;
    options.extension.footnotes = true;
    options.parse.leave_footnote_definitions = true;

    // Bibliography preprocessing preserves source lines; footnotes use native AST nodes.
    let cites = crate::citations::Citations::extract(markdown);
    let body_md = cites.md.clone();

    let arena = Arena::new();
    let root = parse_document(&arena, &body_md, &options);
    let has_headings = root
        .descendants()
        .any(|node| matches!(node.data.borrow().value, NodeValue::Heading(_)));
    let original_root = if body_md != markdown && has_headings {
        parse_document(&arena, markdown, &options)
    } else {
        root
    };
    let heading_slugs = heading_anchors(root, &body_md, original_root, markdown)?;

    let mut ctx = Ctx {
        math,
        diagrams,
        images,
        media: Vec::new(),
        hyperlinks: Vec::new(),
        next_doc_id: 0,
        footnotes: Vec::new(),
        in_footnote: false,
        table_widths: (*table_widths).clone(),
        lang: front_lang,
        heading_slugs,
        next_bookmark_id: 0,
        cite_lines: cites.lines.clone(),
        figures: 0,
        tables: 0,
        comments: DocxComments::new(comments, markdown.split('\n').count())
            .map_err(DocxError::Build)?,
        lists: DocxLists::default(),
    };
    set_hl_fill(highlight.filter(|h| !h.is_empty()).unwrap_or("FFF3A3"));
    render_footnotes(root, &mut ctx)?;
    let mut body = String::new();
    if *toc {
        body.push_str(&toc_field(front_lang));
    }
    if *lof {
        body.push_str(&lof_field(front_lang));
    }
    if *lot {
        body.push_str(&lot_field(front_lang));
    }
    for child in root.children() {
        let from = body.len();
        let line = child.data.borrow().sourcepos.start.line;
        ctx.comments
            .attach(1, line.saturating_sub(1), &mut body, from);
        block(child, &mut ctx, &mut body, 0, false)?;
    }
    let from = body.len();
    ctx.comments.attach(1, usize::MAX, &mut body, from);
    let show_footer = *page_numbers || footer_text.is_some();
    body.push_str(&sect_pr(show_footer, header_title.is_some(), *columns));

    md_core::io::write_file_atomic(out, |file| {
        write_docx_zip(file, &body, &ctx, opts, style.clone()).map_err(std::io::Error::other)
    })?;
    Ok(())
}

/// 네이티브 목차 필드 — w:dirty로 열 때 Word가 항목을 채운다(제목 1~3,
/// 하이퍼링크). 문서 첫머리에 "목차" 제목과 함께.
fn toc_field(lang: &str) -> String {
    format!(
        concat!(
            "<w:sdt><w:sdtPr><w:docPartObj>",
            "<w:docPartGallery w:val=\"Table of Contents\"/><w:docPartUnique/>",
            "</w:docPartObj></w:sdtPr><w:sdtContent>",
            "<w:p><w:pPr><w:pStyle w:val=\"TOCHeading\"/></w:pPr>",
            "<w:r><w:t>{}</w:t></w:r></w:p>",
            "<w:p><w:pPr><w:pStyle w:val=\"TOC1\"/></w:pPr>",
            "<w:r><w:fldChar w:fldCharType=\"begin\" w:dirty=\"true\"/></w:r>",
            "<w:r><w:instrText xml:space=\"preserve\"> TOC \\o \"1-3\" \\h \\z \\u </w:instrText></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
            "<w:r><w:t>{}</w:t></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>",
            "</w:p></w:sdtContent></w:sdt>",
            "<w:p/>"
        ),
        toc_title(lang),
        toc_placeholder(lang)
    )
}

/// 목차 계열 필드 제목 — UI 언어(ko 기본).
fn toc_title(lang: &str) -> &'static str {
    if lang == "en" {
        "Contents"
    } else {
        "목차"
    }
}
fn lof_title(lang: &str) -> &'static str {
    if lang == "en" {
        "List of Figures"
    } else {
        "그림 목차"
    }
}
fn lot_title(lang: &str) -> &'static str {
    if lang == "en" {
        "List of Tables"
    } else {
        "표 목차"
    }
}
fn toc_placeholder(lang: &str) -> &'static str {
    if lang == "en" {
        "(Opens filled in Word)"
    } else {
        "(Word에서 열면 목차가 채워집니다)"
    }
}

/// 섹션 속성 — A4·25mm 여백. 페이지 번호면 바닥글 참조가 먼저 온다(규격 순서).
fn sect_pr(has_footer: bool, has_header: bool, columns: u32) -> String {
    let footer = if has_footer {
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
    // 다단(Word Layout > Columns) — 1단이면 w:cols 생략(기본).
    let cols = if columns > 1 {
        format!("<w:cols w:num=\"{columns}\" w:space=\"425\"/>")
    } else {
        String::new()
    };
    format!(
        "<w:sectPr>{header}{footer}<w:pgSz w:w=\"11906\" w:h=\"16838\"/>{cols}\
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
        "img",
        "image",
        "screenshot",
        "screen",
        "shot",
        "pic",
        "photo",
        "figure",
        "fig",
    ] {
        // 자동 파일명 토큰(img, img_1234, screenshot 2024 …) 하나로 끝나면 제외.
        if let Some(rest) = lower.strip_prefix(prefix) {
            let rest = rest.trim_matches([' ', '_', '-']);
            let rest = rest
                .trim_end_matches(|c: char| c.is_ascii_digit() || c == ' ' || c == '_' || c == '-');
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
        && stem.chars().all(|c| {
            c.is_alphanumeric() || matches!(c, ' ' | '.' | '(' | ')' | '_' | '-' | '[' | ']')
        })
}

/// 표 캡션 문단 — SEQ Table 필드. 그림 캡션과 같은 구조.
/// 라벨은 목차 필드 제목과 같은 언어 규칙("en"이면 Table).
fn table_caption_xml(alt: &str, n: u32, lang: &str) -> String {
    let label = if lang == "en" { "Table " } else { "표 " };
    format!(
        concat!(
            "<w:p><w:pPr><w:pStyle w:val=\"Caption\"/><w:jc w:val=\"center\"/></w:pPr>",
            "<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>",
            "<w:r><w:instrText xml:space=\"preserve\"> SEQ Table \\* ARABIC </w:instrText></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
            "<w:r><w:t>{}</w:t></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>",
            "<w:r><w:t xml:space=\"preserve\"> — {}</w:t></w:r>",
            "</w:p>"
        ),
        label,
        n,
        esc(alt)
    )
}

/// 그림 캡션 문단 — SEQ Figure 필드(Word가 번호를 계속 매김) + 설명.
/// 라벨은 목차 필드 제목과 같은 언어 규칙("en"이면 Figure).
fn figure_caption_xml(alt: &str, n: u32, lang: &str) -> String {
    let label = if lang == "en" { "Figure " } else { "그림 " };
    format!(
        concat!(
            "<w:p><w:pPr><w:pStyle w:val=\"Caption\"/><w:jc w:val=\"center\"/></w:pPr>",
            "<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>",
            "<w:r><w:instrText xml:space=\"preserve\"> SEQ Figure \\* ARABIC </w:instrText></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
            "<w:r><w:t>{}</w:t></w:r>",
            "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>",
            "<w:r><w:t xml:space=\"preserve\"> — {}</w:t></w:r>",
            "</w:p>"
        ),
        label,
        n,
        esc(alt)
    )
}

/// 그림 목차 필드 — SEQ Figure 캡션 항목을 하이퍼링크 목록으로(Word가 채움).
fn lof_field(lang: &str) -> String {
    format!(
        concat!(
        "<w:p><w:pPr><w:pStyle w:val=\"TOCHeading\"/></w:pPr>",
        "<w:r><w:t>{}</w:t></w:r></w:p>",
        "<w:p><w:pPr><w:pStyle w:val=\"TOC1\"/></w:pPr>",
        "<w:r><w:fldChar w:fldCharType=\"begin\" w:dirty=\"true\"/></w:r>",
        "<w:r><w:instrText xml:space=\"preserve\"> TOC \\h \\z \\c \"Figure\" </w:instrText></w:r>",
        "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
        "<w:r><w:t>(Word에서 열면 채워집니다)</w:t></w:r>",
        "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>",
        "</w:p><w:p/>"
        ),
        lof_title(lang)
    )
}

/// 표 목차 필드 — SEQ Table 기반.
fn lot_field(lang: &str) -> String {
    format!(
        concat!(
        "<w:p><w:pPr><w:pStyle w:val=\"TOCHeading\"/></w:pPr>",
        "<w:r><w:t>{}</w:t></w:r></w:p>",
        "<w:p><w:pPr><w:pStyle w:val=\"TOC1\"/></w:pPr>",
        "<w:r><w:fldChar w:fldCharType=\"begin\" w:dirty=\"true\"/></w:r>",
        "<w:r><w:instrText xml:space=\"preserve\"> TOC \\h \\z \\c \"Table\" </w:instrText></w:r>",
        "<w:r><w:fldChar w:fldCharType=\"separate\"/></w:r>",
        "<w:r><w:t>(Word에서 열면 채워집니다)</w:t></w:r>",
        "<w:r><w:fldChar w:fldCharType=\"end\"/></w:r>",
        "</w:p><w:p/>"
        ),
        lot_title(lang)
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

/// 바닥글 — 가운데 자유 텍스트(선택) + "현재 페이지 / 전체 페이지"
/// (PAGE·NUMPAGES 필드, 9pt 회색). 필드 결과값(1 등)은 Word가 열 때 다시 계산한다.
fn footer_xml(text: Option<&str>, show_page: bool) -> String {
    const RPR: &str =
        "<w:rPr><w:sz w:val=\"18\"/><w:szCs w:val=\"18\"/><w:color w:val=\"808080\"/></w:rPr>";
    let field = |instr: &str, shown: &str| {
        format!(
            "<w:r>{RPR}<w:fldChar w:fldCharType=\"begin\"/></w:r>\
<w:r>{RPR}<w:instrText xml:space=\"preserve\"> {instr} </w:instrText></w:r>\
<w:r>{RPR}<w:fldChar w:fldCharType=\"separate\"/></w:r>\
<w:r>{RPR}<w:t>{shown}</w:t></w:r>\
<w:r>{RPR}<w:fldChar w:fldCharType=\"end\"/></w:r>"
        )
    };
    let text_run = match (text, show_page) {
        (Some(t), true) => format!(
            "<w:r>{RPR}<w:t xml:space=\"preserve\">{} · </w:t></w:r>",
            crate::xml::esc(t)
        ),
        (Some(t), false) => format!("<w:r>{RPR}<w:t>{}</w:t></w:r>", crate::xml::esc(t)),
        (None, _) => String::new(),
    };
    let fields = if show_page {
        format!(
            "{}<w:r>{RPR}<w:t xml:space=\"preserve\"> / </w:t></w:r>{}",
            field("PAGE", "1"),
            field("NUMPAGES", "1")
        )
    } else {
        String::new()
    };
    format!(
        concat!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>",
            "<w:ftr xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
            "<w:p><w:pPr><w:jc w:val=\"center\"/></w:pPr>",
            "{text_run}",
            "{fields}",
            "</w:p></w:ftr>"
        ),
        text_run = text_run,
        fields = fields,
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
    let from = out.len();
    block_content(node, ctx, out, list_level, in_quote)?;
    let pos = node.data.borrow().sourcepos;
    ctx.comments.attach(pos.start.line, pos.end.line, out, from);
    Ok(())
}

fn block_content<'a>(
    node: &'a AstNode<'a>,
    ctx: &mut Ctx<'_>,
    out: &mut String,
    list_level: usize,
    in_quote: bool,
) -> Result<(), DocxError> {
    match &node.data.borrow().value {
        NodeValue::Paragraph => {
            // 페이지 나눔 매크로 문단(`\newpage` 등) — Word의 쪽 나눔으로.
            let mut ptext = String::new();
            for c in node.children().collect::<Vec<_>>() {
                if let NodeValue::Text(t) = &c.data.borrow().value {
                    ptext.push_str(t);
                }
            }
            if is_page_break(&ptext) {
                let _ = writeln!(out, "<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>");
                return Ok(());
            }
            let InlineContent { runs, captions } = inline_children(node, ctx, list_level)?;
            let quote = if in_quote {
                " w:val=\"IYAGIQuote\""
            } else {
                ""
            };
            let _ = writeln!(
                out,
                "<w:p><w:pPr><w:pStyle{quote}/></w:pPr>{runs}</w:p>{captions}"
            );
        }
        NodeValue::Heading(h) => {
            let InlineContent { runs, captions } = inline_children(node, ctx, list_level)?;
            let level = h.level.clamp(1, 6);
            let line = node.data.borrow().sourcepos.start.line;
            let slug = ctx
                .heading_slugs
                .get(&line)
                .ok_or_else(|| DocxError::Build("Missing heading anchor".into()))?
                .clone();
            let bm = ctx.bookmark_xml(&slug);
            let _ = writeln!(
                out,
                "<w:p><w:pPr><w:pStyle w:val=\"Heading{level}\"/></w:pPr>{bm}{runs}</w:p>{captions}"
            );
        }
        NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_) => {
            // 콜아웃 — 첫 문단이 [!유형]으로 시작하면 한 칸 표 카드로 꾸민다.
            if let Some((key, title)) = callout_of(node) {
                callout_block(node, &key, &title, ctx, out)?;
                return Ok(());
            }
            for c in node.children() {
                block(c, ctx, out, list_level, true)?;
            }
        }
        NodeValue::List(metadata) => {
            let list = ctx.lists.add(metadata, list_level);
            for c in node.children() {
                list_item(c, ctx, out, list_level, list, in_quote)?;
            }
        }
        NodeValue::CodeBlock(cb) => {
            code_block(cb, node.data.borrow().sourcepos.start.line, ctx, out)?
        }
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
        // Kept at the original source position for comment anchors, rendered
        // separately into word/footnotes.xml.
        NodeValue::FootnoteDefinition(_) => {}
        NodeValue::DescriptionList => {
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
    list: ListInstance,
    in_quote: bool,
) -> Result<(), DocxError> {
    let task = match &node.data.borrow().value {
        NodeValue::TaskItem(task) => Some(task.symbol.is_some()),
        _ => None,
    };
    let mut first = true;
    // Non-paragraph and empty items still own one marker. A later paragraph
    // belongs to the same item and must not consume another number.
    if !node
        .first_child()
        .is_some_and(|child| matches!(child.data.borrow().value, NodeValue::Paragraph))
    {
        let from = out.len();
        list_paragraph(out, list, first, task, in_quote, InlineContent::default());
        let line = node.data.borrow().sourcepos.start.line;
        ctx.comments.attach(line, line, out, from);
        first = false;
    }
    for c in node.children() {
        match &c.data.borrow().value {
            NodeValue::Paragraph => {
                let content = inline_children(c, ctx, level)?;
                let from = out.len();
                list_paragraph(out, list, first, task, in_quote, content);
                first = false;
                let pos = c.data.borrow().sourcepos;
                ctx.comments.attach(pos.start.line, pos.end.line, out, from);
            }
            _ => block(c, ctx, out, level + 1, in_quote)?,
        }
    }
    Ok(())
}

fn list_paragraph(
    out: &mut String,
    list: ListInstance,
    first: bool,
    task: Option<bool>,
    in_quote: bool,
    content: InlineContent,
) {
    let properties = list.paragraph_properties(first, task.is_some());
    let quote = if in_quote {
        "<w:pStyle w:val=\"IYAGIQuote\"/>"
    } else {
        ""
    };
    let _ = write!(out, "<w:p><w:pPr>{quote}{properties}</w:pPr>");
    if let Some(checked) = task.filter(|_| first) {
        let _ = write!(out,
            "<w:r><w:rPr><w:sz w:val=\"22\"/></w:rPr><w:sym w:font=\"Wingdings\" w:char=\"F0{}\"/></w:r>",
            if checked { "FE" } else { "A8" });
        if list.ordered {
            out.push_str("<w:r><w:t xml:space=\"preserve\"> </w:t></w:r>");
        } else {
            out.push_str("<w:r><w:tab/></w:r>");
        }
    }
    let InlineContent { runs, captions } = content;
    let _ = writeln!(out, "{runs}</w:p>{captions}");
}

fn code_block(
    cb: &NodeCodeBlock,
    source_line: usize,
    ctx: &mut Ctx,
    out: &mut String,
) -> Result<(), DocxError> {
    let info = cb.info.trim().to_ascii_lowercase();
    let code = cb.literal.trim_matches('\n');
    // mermaid → 편집 가능 도형 그룹(§4-3).
    if info == "mermaid" {
        let id = ctx.next_id();
        if let Some(svg) = ctx.diagrams.get(code) {
            match svg_to_drawingml(svg, PAGE_TEXT_WIDTH_EMU, id) {
                Ok(drawing) => {
                    let _ = writeln!(out, "<w:p><w:r>{drawing}</w:r></w:p>");
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
    let literal = cb.literal.strip_suffix('\n').unwrap_or(&cb.literal);
    for (index, line) in literal.split('\n').enumerate() {
        let from = out.len();
        let _ = writeln!(
            out,
            "<w:p><w:pPr><w:pStyle w:val=\"IYAGICode\"/><w:ind w:left=\"0\"/></w:pPr>\
<w:r><w:rPr><w:rFonts w:ascii=\"Menlo\" w:hAnsi=\"Menlo\"/><w:sz w:val=\"18\"/></w:rPr><w:t{PRESERVE}>{}</w:t></w:r></w:p>",
            esc(line)
        );
        let source = source_line + usize::from(cb.fenced) + index;
        ctx.comments.attach(source, source, out, from);
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

/// 셀/이미지 설명의 텍스트 수집(재귀 — 인라인 서식과 코드 안까지).
fn collect_text<'a>(node: &'a AstNode<'a>, out: &mut String) {
    match &node.data.borrow().value {
        NodeValue::Text(t) => out.push_str(t),
        NodeValue::Code(c) => out.push_str(&c.literal),
        NodeValue::SoftBreak | NodeValue::LineBreak => out.push(' '),
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
            w.iter()
                .map(|&x| ((8640.0 * f64::from(x)) / sum).round() as i64)
                .collect()
        }
        None => vec![8640 / n_cols.max(1) as i64; n_cols],
    };
    // 열 인덱스가 그리드를 넘는 셀의 폭 폴백 — col_tws가 비는 변태 표
    // (num_columns=0)에서 [0] 인덱싱이 패닉하지 않게 안전 접근.
    let col_tw = col_tws.first().copied().unwrap_or(8640);
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
                let from = out.len();
                let align = t.alignments.get(col_idx).copied();
                let InlineContent { runs, captions } = inline_children(cell, ctx, 0)?;
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
<w:p><w:pPr>{jc}<w:rPr>{bold}</w:rPr></w:pPr>{runs}</w:p>{captions}</w:tc>"
                );
                if col_idx == 0 {
                    let pos = row.data.borrow().sourcepos;
                    ctx.comments.attach(pos.start.line, pos.end.line, out, from);
                }
                col_idx += 1;
            }
            out.push_str("</w:tr>");
        }
    }
    // 표 뒤 빈 문단(Word 관례) + 캡션(SEQ Table — Word가 번호 갱신).
    out.push_str("</w:tbl><w:p/>");
    if let Some(cap) = caption {
        ctx.tables += 1;
        let from = out.len();
        out.push_str(&table_caption_xml(&cap, ctx.tables, ctx.lang));
        if let Some(row) = rows.last() {
            let pos = row.data.borrow().sourcepos;
            ctx.comments.attach(pos.start.line, pos.end.line, out, from);
        }
    }
    Ok(())
}

// — 인라인 —

/// 콜아웃 유형 — 강조색(왼쪽 테두리)과 연한 채움색. (유형, 표시문구)
fn callout_palette(key: &str) -> (&'static str, &'static str, &'static str) {
    match key {
        "note" => ("448AFF", "E8F0FE", "\u{1F4DD}"),
        "info" => ("3BA9F0", "E7F4FD", "\u{2139}\u{FE0F}"),
        "abstract" => ("00BFBC", "E0F7F7", "\u{1F4CB}"),
        "todo" => ("F9B24A", "FEF3E2", "\u{2611}\u{FE0F}"),
        "tip" => ("00C9A7", "E0F8F4", "\u{1F4A1}"),
        "success" => ("3FB950", "E9F7EE", "\u{2705}"),
        "question" => ("BA832C", "F8F0E2", "\u{2753}"),
        "warning" => ("E9A23B", "FDF2E1", "\u{26A0}\u{FE0F}"),
        "failure" => ("E5484D", "FCE9EA", "\u{274C}"),
        "danger" => ("F5493D", "FDE9E7", "\u{1F6D1}"),
        "bug" => ("E5484D", "FCE9EA", "\u{1F41B}"),
        "example" => ("A882FF", "F1EAFF", "\u{1F9EA}"),
        _ => ("9E9E9E", "F0F0F0", "\u{275D}"), // quote 등 기본
    }
}

/// 인용문 노드가 콜아웃인지 — 첫 문단 첫 줄이 `[!유형](+/-)? 제목`.
fn callout_of<'a>(node: &'a AstNode<'a>) -> Option<(String, String)> {
    let first = node
        .children()
        .find(|c| matches!(c.data.borrow().value, NodeValue::Paragraph))?;
    // 첫 줄까지만 — softbreak(지연 연속) 뒤는 본문이다.
    let mut text = String::new();
    let mut stop = false;
    for d in first.descendants() {
        if stop {
            break;
        }
        match &d.data.borrow().value {
            NodeValue::SoftBreak | NodeValue::LineBreak => stop = true,
            NodeValue::Text(t) => text.push_str(t),
            _ => {}
        }
    }
    let line = text.trim();
    let rest = line.strip_prefix("[!")?;
    let close = rest.find(']')?;
    let raw = &rest[..close];
    if raw.is_empty() || !raw.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    let after = &rest[close + 1..];
    let after = after
        .strip_prefix('+')
        .or_else(|| after.strip_prefix('-'))
        .unwrap_or(after);
    let key = normalize_callout(raw);
    Some((key, after.trim().to_string()))
}

fn normalize_callout(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    let key = match lower.as_str() {
        "tldr" | "summary" => "abstract",
        "hint" | "important" => "tip",
        "check" | "done" => "success",
        "help" | "faq" => "question",
        "caution" | "attention" => "warning",
        "fail" | "missing" => "failure",
        "error" => "danger",
        "cite" => "quote",
        "note" | "abstract" | "info" | "todo" | "tip" | "success" | "question" | "warning"
        | "failure" | "danger" | "bug" | "example" | "quote" => lower.as_str(),
        _ => "note",
    };
    key.to_string()
}

/// 콜아웃 본문 — 첫 문단의 첫 줄(마커·제목)을 떼고 카드 안에 넣는다.
fn callout_block<'a>(
    node: &'a AstNode<'a>,
    key: &str,
    title: &str,
    ctx: &mut Ctx<'_>,
    out: &mut String,
) -> Result<(), DocxError> {
    let (accent, fill, icon) = callout_palette(key);
    // 본문 — 첫 문단의 첫 줄(마커·제목)을 떼고, 나머지 블록을 카드 안에.
    // 셀 배경(tcPr shd)이 카드 색을 제공하므로 안쪽 문단은 색을 입히지 않는다.
    let mut body = String::new();
    let mut first = true;
    for c in node.children() {
        if first {
            first = false;
            // 첫 softbreak 이후(지연 연속 줄)의 텍스트만 본문 문단으로.
            let mut rest = String::new();
            let mut after_break = false;
            let mut stop = false;
            for d in c.descendants() {
                if stop {
                    break;
                }
                match &d.data.borrow().value {
                    NodeValue::SoftBreak | NodeValue::LineBreak => {
                        if after_break {
                            stop = true;
                        } else {
                            after_break = true;
                        }
                    }
                    NodeValue::Text(t) if after_break => rest.push_str(t),
                    _ => {}
                }
            }
            let trimmed = rest.trim();
            if !trimmed.is_empty() {
                let _ = write!(
                    body,
                    "<w:p><w:pPr><w:spacing w:after=\"40\"/></w:pPr>{}</w:p>",
                    plain_run(trimmed, &RunStyle::default())
                );
            }
            continue;
        }
        let mut inner = String::new();
        for child in c.children() {
            block(child, ctx, &mut inner, 0, false)?;
        }
        body.push_str(&inner);
    }
    let _ = write!(out,
        "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/>\
<w:tblBorders><w:top w:val=\"none\" w:sz=\"0\" w:color=\"auto\"/>\
<w:left w:val=\"single\" w:sz=\"18\" w:color=\"{accent}\"/>\
<w:bottom w:val=\"none\" w:sz=\"0\" w:color=\"auto\"/>\
<w:right w:val=\"none\" w:sz=\"0\" w:color=\"auto\"/>\
<w:insideH w:val=\"none\" w:sz=\"0\" w:color=\"auto\"/>\
<w:insideV w:val=\"none\" w:sz=\"0\" w:color=\"auto\"/></w:tblBorders>\
<w:tblCellMar><w:top w:w=\"60\" w:type=\"dxa\"/><w:left w:w=\"140\" w:type=\"dxa\"/>\
<w:bottom w:w=\"60\" w:type=\"dxa\"/><w:right w:w=\"140\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr>\
<w:tblGrid><w:gridCol w:w=\"9000\"/></w:tblGrid>\
<w:tr><w:tc><w:tcPr><w:shd w:val=\"clear\" w:fill=\"{fill}\"/><w:tcW w:w=\"0\" w:type=\"auto\"/></w:tcPr>\
<w:p><w:pPr><w:spacing w:after=\"40\"/></w:pPr>\
<w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">{icon} {}</w:t></w:r></w:p>{}\
</w:tc></w:tr></w:tbl><w:p/>",
        esc(title),
        body
    );
    Ok(())
}

fn plain_run(text: &str, style: &RunStyle) -> String {
    if text.is_empty() {
        return String::new();
    }
    // rpr(style): 굵게·기울임·취소·위첨자 등 인라인 서식 런 속성(각주 안
    // 인라인이 사라지던 회귀 수정 — 스타일이 무시돼선 안 된다).
    format!(
        "<w:r>{}<w:t{}>{}</w:t></w:r>",
        rpr(style),
        PRESERVE,
        esc(text)
    )
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

/// 하이퍼링크 안 런들에 Hyperlink 글자 스타일 주입 — 이미 rPr가 있으면
/// 그 안 맨 앞에 rStyle을(rPr 첫 자리가 규격 순서), 없으면 rPr를 새로 만든다.
fn apply_hyperlink_style(runs: &str) -> String {
    // rPr가 있는 런은 rStyle을 맨 앞에 삽입, 없는 런은 새 rPr를 만든다.
    // rPr 뒤에 올 수 있는 모든 첫 자식(w:t·w:br·w:tab)을 커버한다.
    runs.replace(
        "<w:r><w:rPr>",
        "<w:r><w:rPr><w:rStyle w:val=\"Hyperlink\"/>",
    )
    .replace(
        "<w:r><w:t",
        "<w:r><w:rPr><w:rStyle w:val=\"Hyperlink\"/></w:rPr><w:t",
    )
    .replace(
        "<w:r><w:br",
        "<w:r><w:rPr><w:rStyle w:val=\"Hyperlink\"/></w:rPr><w:br",
    )
    .replace(
        "<w:r><w:tab",
        "<w:r><w:rPr><w:rStyle w:val=\"Hyperlink\"/></w:rPr><w:tab",
    )
}

fn render_footnotes<'a>(root: &'a AstNode<'a>, ctx: &mut Ctx<'_>) -> Result<(), DocxError> {
    let ids: HashMap<String, u32> = root
        .descendants()
        .filter_map(|node| match &node.data.borrow().value {
            NodeValue::FootnoteReference(reference) => Some((reference.name.clone(), reference.ix)),
            _ => None,
        })
        .collect();
    let comments = std::mem::take(&mut ctx.comments);
    ctx.in_footnote = true;
    let mut emitted = std::collections::HashSet::new();
    for node in root.descendants() {
        let id = match &node.data.borrow().value {
            NodeValue::FootnoteDefinition(definition) if definition.total_references > 0 => {
                ids.get(&definition.name).copied()
            }
            _ => None,
        };
        let Some(id) = id else {
            continue;
        };
        if !emitted.insert(id) {
            continue;
        }
        let mut content = String::new();
        for child in node.children() {
            block(child, ctx, &mut content, 0, false)?;
        }
        // Number the first paragraph, including list/table-first definitions.
        let start = match content.find("<w:p>") {
            Some(at) => at + "<w:p>".len(),
            None => {
                content.insert_str(0, "<w:p></w:p>");
                "<w:p>".len()
            }
        };
        let insert = if content[start..].starts_with("<w:pPr>") {
            start
                + content[start..]
                    .find("</w:pPr>")
                    .expect("generated footnote properties")
                + "</w:pPr>".len()
        } else {
            start
        };
        content.insert_str(insert,
            "<w:r><w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space=\"preserve\"> </w:t></w:r>");
        ctx.footnotes.push((id, content));
    }
    ctx.footnotes.sort_by_key(|(id, _)| *id);
    ctx.in_footnote = false;
    // Notes on the definition source stay in the main document at that position.
    ctx.comments = comments;
    Ok(())
}

/// word/footnotes.xml — separators plus complete native footnote block content.
fn footnotes_xml(ctx: &Ctx) -> String {
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:footnotes xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" \
xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" \
xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\" \
xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\" \
xmlns:wpg=\"http://schemas.microsoft.com/office/word/2010/wordprocessingGroup\">\
<w:footnote w:type=\"separator\" w:id=\"-1\"><w:p><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>\
<w:footnote w:type=\"continuationSeparator\" w:id=\"0\"><w:p><w:pPr><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>",
    );
    for (id, content) in &ctx.footnotes {
        let _ = write!(s, "<w:footnote w:id=\"{id}\">{content}</w:footnote>");
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
    let shd = format!(
        r#"<w:shd w:val="clear" w:color="auto" w:fill="{}"/>"#,
        hl_fill()
    );
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

/// 문단 전체가 페이지 나눔 매크로인지(pandoc 규약 `\newpage` 등 — 프런트와 동일 판정).
fn is_page_break(s: &str) -> bool {
    let t = s.trim();
    t == "\\newpage" || t == "\\pagebreak" || t == "\\page"
}

/// Captions are block content, even when their image occurs inside a link or
/// styled text. The caller places them after the containing paragraph.
#[derive(Default)]
struct InlineContent {
    runs: String,
    captions: String,
}

fn inline_children<'a>(
    node: &'a AstNode<'a>,
    ctx: &mut Ctx<'_>,
    level: usize,
) -> Result<InlineContent, DocxError> {
    let mut content = InlineContent::default();
    for c in node.children() {
        // Adjacent bibliography lines may share a Markdown paragraph. Attach
        // every canonical destination once, not only the paragraph's first line.
        let line = c.data.borrow().sourcepos.start.line as u32;
        if let Some(key) = ctx.cite_lines.remove(&line) {
            content
                .runs
                .push_str(&ctx.bookmark_xml(&format!("ref-{key}")));
        }
        inline(
            c,
            ctx,
            &mut content.runs,
            &mut content.captions,
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
    Ok(content)
}

fn inline<'a>(
    node: &'a AstNode<'a>,
    ctx: &mut Ctx<'_>,
    out: &mut String,
    captions: &mut String,
    style: &RunStyle,
    _level: usize,
) -> Result<(), DocxError> {
    match &node.data.borrow().value {
        NodeValue::FootnoteReference(reference) => {
            if ctx.in_footnote {
                // Keep nested references visible without emitting a nested native note.
                out.push_str(&plain_run(&format!("[^{}]", reference.name), style));
            } else {
                let _ = write!(out,
                    "<w:r><w:rPr><w:vertAlign w:val=\"superscript\"/></w:rPr><w:footnoteReference w:id=\"{}\"/></w:r>",
                    reference.ix);
            }
        }
        NodeValue::Text(t) => out.push_str(&text_run(t, style)),
        NodeValue::Code(c) => out.push_str(&plain_run(
            &c.literal,
            &RunStyle {
                code: true,
                ..*style
            },
        )),
        NodeValue::SoftBreak => out.push_str(&plain_run(" ", style)),
        NodeValue::LineBreak => out.push_str("<w:r><w:br/></w:r>"),
        NodeValue::Emph => {
            let s = RunStyle {
                italic: true,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, out, captions, &s, _level)?;
            }
        }
        NodeValue::Strong => {
            let s = RunStyle {
                bold: true,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, out, captions, &s, _level)?;
            }
        }
        NodeValue::Strikethrough => {
            let s = RunStyle {
                strike: true,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, out, captions, &s, _level)?;
            }
        }
        NodeValue::Superscript => {
            let s = RunStyle {
                sup: true,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, out, captions, &s, _level)?;
            }
        }
        NodeValue::Subscript => {
            let s = RunStyle {
                sub: true,
                ..*style
            };
            for c in node.children() {
                inline(c, ctx, out, captions, &s, _level)?;
            }
        }
        NodeValue::Underline => {
            for c in node.children() {
                inline(c, ctx, out, captions, style, _level)?;
            }
        }
        NodeValue::Link(link) => {
            let mut runs = String::new();
            let citation = link.title == crate::citations::CITATION_TITLE;
            let s = RunStyle {
                italic: citation && style.italic,
                sup: citation || style.sup,
                sub: !citation && style.sub,
                ..*style
            };
            if citation {
                let mut display = String::new();
                collect_text(node, &mut display);
                // 강조가 링크 막을 안으로 접혀 들어온 형태(`**[@key]**` →
                // Link>Strong)도 표시에 반영한다.
                let mut s = s;
                for child in node.descendants() {
                    match &child.data.borrow().value {
                        NodeValue::Strong => s.bold = true,
                        NodeValue::Emph => s.italic = true,
                        NodeValue::Strikethrough => s.strike = true,
                        _ => {}
                    }
                }
                runs.push_str(&plain_run(&display, &s));
            } else {
                for c in node.children() {
                    inline(c, ctx, &mut runs, captions, &s, _level)?;
                }
            }
            // 내부 앵커(#슬러그)는 문서 내 북마크로 — 외부 URL만 관계를 쓴다.
            if let Some(anchor) = link.url.strip_prefix('#') {
                if !anchor.is_empty() {
                    let anchor = esc(&md_core::links::percent_decode(anchor));
                    let _ = write!(
                        out,
                        "<w:hyperlink w:anchor=\"{anchor}\">{}</w:hyperlink>",
                        apply_hyperlink_style(&runs)
                    );
                    return Ok(());
                }
            }
            let id = ctx.add_hyperlink(&link.url);
            let _ = write!(
                out,
                "<w:hyperlink r:id=\"rIdH{id}\">{}</w:hyperlink>",
                apply_hyperlink_style(&runs)
            );
        }
        NodeValue::Image(link) => {
            let mut alt = String::new();
            collect_text(node, &mut alt);
            if let Some(drawing) = image_drawing(ctx, &link.url) {
                out.push_str(&drawing);
                // 캡션 후보 alt면 그림 캡션 문단(SEQ Figure — Word가 갱신).
                if caption_worthy(&alt) {
                    ctx.figures += 1;
                    captions.push_str(&figure_caption_xml(&alt, ctx.figures, ctx.lang));
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
                inline(c, ctx, out, captions, style, _level)?;
            }
        }
    }
    Ok(())
}

/// 이미지 → 인라인 그림(비트맵) 또는 도형 그룹(SVG, §4-3).
fn image_drawing(ctx: &mut Ctx, url: &str) -> Option<String> {
    // 사이드카 폭(%) — 편집기에서 드래그한 값과 동일하게 축소.
    let pct = ctx.images.width(url).unwrap_or(100).clamp(5, 100) as f64 / 100.0;
    let path = ctx.images.resolve_url(url)?;
    let bytes = ctx.images.read(url)?;
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
    {
        let svg = String::from_utf8(bytes).ok()?;
        let id = ctx.next_id();
        let drawing = svg_to_drawingml(&svg, (PAGE_TEXT_WIDTH_EMU as f64 * pct) as i64, id).ok()?;
        return Some(format!("<w:r>{drawing}</w:r>"));
    }
    let ext = detect_image(&bytes)?;
    // 크기: 이미지 헤더에서 추출, 실패 시 4x3in.
    let (w_px, h_px) = image_dimensions(&bytes).unwrap_or((384, 288));
    let scale = (PAGE_TEXT_WIDTH_EMU as f64 / (w_px as f64 * 9525.0)).min(1.0) * pct;
    let cx = (w_px as f64 * 9525.0 * scale).round() as i64;
    let cy = (h_px as f64 * 9525.0 * scale).round() as i64;
    let (name, relationship_id) = ctx.add_media(bytes, ext);
    let id = ctx.next_id();
    Some(format!(
        "<w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">\
<wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/>\
<wp:docPr id=\"{id}\" name=\"Image {id}\"/>\
<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr>\
<a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
<pic:pic><pic:nvPicPr><pic:cNvPr id=\"{id}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr>\
<pic:blipFill><a:blip r:embed=\"rIdImg{relationship_id}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>\
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
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        // 웹에서 복사한 이미지에 흔하다 — 없으면 Word 내보내기에서 조용히 사라진다.
        Some("webp")
    } else {
        None
    }
}

/// PNG/JPEG/GIF/WebP 크기 헤더 파싱(외부 크레이트 없이).
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
    } else if bytes.len() >= 30 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        // 청크 포맷 — VP8X(확장)는 캔버스 크기, VP8/VP8L은 프레임 헤더에서.
        match &bytes[12..16] {
            b"VP8X" => {
                // 캔버스 폭·높이 = 저장값(24비트 LE) + 1.
                let w = (u32::from(bytes[24])
                    | (u32::from(bytes[25]) << 8)
                    | (u32::from(bytes[26]) << 16))
                    + 1;
                let h = (u32::from(bytes[27])
                    | (u32::from(bytes[28]) << 8)
                    | (u32::from(bytes[29]) << 16))
                    + 1;
                return Some((w, h));
            }
            b"VP8 " => {
                // 무손실 압축 아님(유손실) — 시작 코드 9D 01 2A 뒤 LE16(&0x3FFF).
                if bytes[23..26] == [0x9D, 0x01, 0x2A] {
                    let w = (u16::from_le_bytes(bytes[26..28].try_into().ok()?) & 0x3FFF) as u32;
                    let h = (u16::from_le_bytes(bytes[28..30].try_into().ok()?) & 0x3FFF) as u32;
                    return Some((w, h));
                }
            }
            b"VP8L" => {
                // 시그니처 0x2F 뒤 32비트 LE에 폭·높이(각 14비트, -1 저장).
                if bytes[20] == 0x2F {
                    let v = u32::from_le_bytes(bytes[21..25].try_into().ok()?);
                    return Some(((v & 0x3FFF) + 1, ((v >> 14) & 0x3FFF) + 1));
                }
            }
            _ => {}
        }
    }
    None
}

// — 패키지(zip) 작성 —

/// comments.xml — 본문에 연결된 메모와 작성자.
fn comments_xml(ctx: &Ctx) -> String {
    ctx.comments.xml()
}

fn write_docx_zip(
    file: &mut std::fs::File,
    body: &str,
    ctx: &Ctx,
    opts: &DocxExportOptions<'_>,
    style: Option<(&str, f64, f64, bool, String, String)>,
) -> Result<(), DocxError> {
    let (page_numbers, title, author, toc, lof, lot, header_title, footer_text) = (
        opts.page_numbers,
        opts.title,
        opts.author,
        opts.toc,
        opts.lof,
        opts.lot,
        opts.header_title,
        opts.footer_text,
    );
    let mut zip = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let add = |zip: &mut zip::ZipWriter<&mut std::fs::File>,
               name: &str,
               data: &str|
     -> Result<(), DocxError> {
        zip.start_file(name, opts)?;
        Ok(zip.write_all(data.as_bytes())?)
    };

    let has_footnotes = !ctx.footnotes.is_empty();
    add(
        &mut zip,
        "[Content_Types].xml",
        &content_types(
            ctx,
            page_numbers || footer_text.is_some(),
            header_title.is_some(),
            !ctx.comments.is_empty(),
        ),
    )?;
    add(&mut zip, "_rels/.rels", RELS_ROOT)?;
    add(&mut zip, "word/document.xml", &document(body))?;
    if has_footnotes {
        add(&mut zip, "word/footnotes.xml", &footnotes_xml(ctx))?;
        add(
            &mut zip,
            "word/_rels/footnotes.xml.rels",
            &footnote_rels(ctx),
        )?;
    }
    if page_numbers || footer_text.is_some() {
        add(
            &mut zip,
            "word/footer1.xml",
            &footer_xml(footer_text, page_numbers),
        )?;
    }
    if !ctx.comments.is_empty() {
        add(&mut zip, "word/comments.xml", &comments_xml(ctx))?;
    }
    if let Some(ht) = header_title {
        add(&mut zip, "word/header1.xml", &header_xml(ht))?;
        add(&mut zip, "word/headerFirst.xml", &header_first_xml())?;
    }
    add(
        &mut zip,
        "word/_rels/document.xml.rels",
        &document_rels(
            ctx,
            page_numbers || footer_text.is_some(),
            header_title.is_some(),
            !ctx.comments.is_empty(),
        ),
    )?;
    add(&mut zip, "word/styles.xml", &styles_xml(style))?;
    add(&mut zip, "word/numbering.xml", &ctx.lists.xml())?;
    add(
        &mut zip,
        "word/settings.xml",
        &settings_xml(toc || lof || lot),
    )?;
    add(&mut zip, "docProps/core.xml", &core_props(title, author))?;
    add(&mut zip, "docProps/app.xml", APP)?;

    for (name, bytes) in &ctx.media {
        zip.start_file(format!("word/{name}"), opts)?;
        zip.write_all(bytes)?;
    }
    zip.finish()?;
    Ok(())
}

fn content_types(ctx: &Ctx, page_numbers: bool, has_header: bool, has_comments: bool) -> String {
    let mut media_defaults = String::new();
    let mut seen = std::collections::HashSet::new();
    for (_, bytes) in &ctx.media {
        let ext = detect_image(bytes).unwrap_or("png");
        if seen.insert(ext) {
            let mime = match ext {
                "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "bmp" => "image/bmp",
                "webp" => "image/webp",
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
            "{comments_ct}",
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
        comments_ct = if has_comments {
            "<Override PartName=\"/word/comments.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml\"/>"
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

fn document_rels(ctx: &Ctx, page_numbers: bool, has_header: bool, has_comments: bool) -> String {
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
    if has_comments {
        let _ = write!(
            s,
            "<Relationship Id=\"rIdComments\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments\" Target=\"comments.xml\"/>"
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
    append_resource_rels(ctx, &mut s);
    s.push_str("</Relationships>");
    s
}

fn footnote_rels(ctx: &Ctx) -> String {
    let mut s = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
    append_resource_rels(ctx, &mut s);
    s.push_str("</Relationships>");
    s
}

fn append_resource_rels(ctx: &Ctx, s: &mut String) {
    for (i, url) in ctx.hyperlinks.iter().enumerate() {
        let _ = write!(
            s,
            "<Relationship Id=\"rIdH{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",
            i + 1,
            esc(url)
        );
    }
    for (idx, (name, _)) in ctx.media.iter().enumerate() {
        let id = idx + 1;
        let _ = write!(
            s,
            "<Relationship Id=\"rIdImg{id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"{name}\"/>"
        );
    }
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
<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/>
<w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/>
<w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>
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
    let t = esc(title
        .filter(|s| !s.is_empty())
        .unwrap_or("IYAGI Markdown 문서"));
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

    fn assert_drawing_paragraph_structure(document: &str, expected_drawings: usize) {
        let xml = roxmltree::Document::parse(document).unwrap();
        let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        let drawings: Vec<_> = xml
            .descendants()
            .filter(|node| node.has_tag_name((ns, "drawing")))
            .collect();
        assert_eq!(drawings.len(), expected_drawings);
        for drawing in drawings {
            assert!(drawing.parent().unwrap().has_tag_name((ns, "r")));
        }
        for paragraph in xml
            .descendants()
            .filter(|node| node.has_tag_name((ns, "p")))
        {
            let parent = paragraph.parent().unwrap();
            // Drawing text boxes legitimately contain their own paragraphs.
            assert!(
                ["body", "tc", "footnote", "txbxContent"]
                    .iter()
                    .any(|name| parent.has_tag_name((ns, *name))),
                "unexpected paragraph parent: {:?}",
                parent.tag_name()
            );
        }
    }

    fn assert_bookmark_ids(document: &str, expected_count: usize) {
        let xml = roxmltree::Document::parse(document).unwrap();
        let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        let starts: Vec<_> = xml
            .descendants()
            .filter(|node| node.has_tag_name((ns, "bookmarkStart")))
            .collect();
        let ends: Vec<_> = xml
            .descendants()
            .filter(|node| node.has_tag_name((ns, "bookmarkEnd")))
            .collect();
        assert_eq!(starts.len(), expected_count);
        assert_eq!(ends.len(), expected_count);
        let mut ids = std::collections::HashSet::new();
        for start in starts {
            let id = start.attribute((ns, "id")).unwrap();
            assert!(
                id.parse::<u32>().is_ok(),
                "bookmark ID must be numeric: {id}"
            );
            assert!(ids.insert(id), "duplicate bookmark ID: {id}");
            assert_eq!(
                ends.iter()
                    .filter(|end| end.attribute((ns, "id")) == Some(id))
                    .count(),
                1
            );
        }
    }

    #[test]
    fn heading_anchors_preserve_inline_source_and_container_titles() {
        let md = "# **Strong** `code` [link](dest.md)\n\n첫 줄\n둘째 줄\n====\n\n> 인용 첫 줄\n> 다음 줄\n> ----\n\n# A &amp; B\n\n#\n\n- # 목록\n";
        let arena = Arena::new();
        let root = parse_document(&arena, md, &Options::default());
        let anchors = heading_anchors(root, md, root, md).unwrap();
        let mut ordered: Vec<_> = anchors.into_iter().collect();
        ordered.sort_by_key(|(line, _)| *line);
        assert_eq!(
            ordered,
            [
                (1, "strong-code-linkdestmd".to_string()),
                (3, "첫-줄-둘째-줄".to_string()),
                (7, "인용-첫-줄-다음-줄".to_string()),
                (11, "a-amp-b".to_string()),
                (13, "section".to_string()),
                (15, "목록".to_string()),
            ]
        );
    }

    #[test]
    fn callout_marker_detection_covers_aliases_folds_and_plain_quotes() {
        let arena = Arena::new();
        let parse = |md: &str| {
            let root = parse_document(&arena, md, &Options::default());
            root.children()
                .find(|c| matches!(c.data.borrow().value, NodeValue::BlockQuote))
                .unwrap()
        };
        let quote = parse("> [!tip] 캐시 규칙\n> 본문\n");
        assert_eq!(callout_of(quote), Some(("tip".into(), "캐시 규칙".into())));
        let quote = parse("> [!tldr]+ 요약\n");
        assert_eq!(callout_of(quote), Some(("abstract".into(), "요약".into())));
        let quote = parse("> [!warning]-\n> 경고\n");
        assert_eq!(callout_of(quote), Some(("warning".into(), String::new())));
        let quote = parse("> 일반 인용문\n");
        assert_eq!(callout_of(quote), None);
        // 마커 모양만 있고 유형이 빈 경우는 콜아웃이 아니다.
        let quote = parse("> [!] 빈 유형\n");
        assert_eq!(callout_of(quote), None);
    }

    #[test]
    fn callouts_export_as_filled_card_tables() {
        let md = "> [!success] 완료\n> 다 되었습니다.\n\n> [!question] 질문\n\n일반 문단\n";
        let out = tmp("callouts");
        export_docx(
            md,
            &DocxExportOptions {
                math: &HashMap::new(),
                diagrams: &HashMap::new(),
                images: &ImageSource::new(String::new()),
                style: None,
                page_numbers: false,
                table_widths: &HashMap::new(),
                title: None,
                author: None,
                toc: false,
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
        let _ = std::fs::remove_file(&out);
        // 카드 — 유형색 왼쪽 테두리 + 연한 채움 + 굵은 제목(아이콘 포함).
        assert!(doc.contains("w:color=\"3FB950\""), "success 강조색");
        assert!(doc.contains("w:fill=\"E9F7EE\""), "success 채움색");
        assert!(doc.contains("w:color=\"BA832C\""), "question 강조색");
        assert!(doc.contains("<w:b/>"), "제목 굵게");
        assert!(doc.contains("완료"));
        assert!(doc.contains("다 되었습니다"));
        assert!(doc.contains("일반 문단"));
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p =
            std::env::temp_dir().join(format!("md-export-docx-{tag}-{}.docx", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn citation_headings_and_note_headings_match_shared_anchor_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/heading-anchors.json")).unwrap();
        let markdown = fixture["markdown"].as_str().unwrap();
        let expected = |key: &str| {
            fixture[key]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("original-heading-anchors");
        export_docx(
            markdown,
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "en",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        use std::io::Read;
        let mut body = String::new();
        let mut footnotes = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut body)
            .unwrap();
        zip.by_name("word/footnotes.xml")
            .unwrap()
            .read_to_string(&mut footnotes)
            .unwrap();
        let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        let mut names = std::collections::HashSet::new();
        let mut ids = std::collections::HashSet::new();
        let mut body_expected = expected("bodyAnchors");
        body_expected.extend(expected("bibliographyAnchors"));
        for (xml, expected) in [
            (&body, body_expected),
            (&footnotes, expected("footnoteAnchors")),
        ] {
            let document = roxmltree::Document::parse(xml).unwrap();
            let bookmarks: Vec<_> = document
                .descendants()
                .filter(|node| node.has_tag_name((ns, "bookmarkStart")))
                .collect();
            assert_eq!(
                bookmarks
                    .iter()
                    .map(|node| node.attribute((ns, "name")).unwrap())
                    .collect::<Vec<_>>(),
                expected
            );
            for bookmark in bookmarks {
                assert!(names.insert(bookmark.attribute((ns, "name")).unwrap().to_string()));
                assert!(ids.insert(bookmark.attribute((ns, "id")).unwrap().to_string()));
            }
            assert_bookmark_ids(xml, expected.len());
        }
        let document = roxmltree::Document::parse(&body).unwrap();
        for link in document
            .descendants()
            .filter(|node| node.has_tag_name((ns, "hyperlink")))
        {
            if let Some(anchor) = link.attribute((ns, "anchor")) {
                assert!(names.contains(anchor), "missing target: {anchor}");
            }
        }
        let heading = document
            .descendants()
            .find(|node| {
                node.has_tag_name((ns, "bookmarkStart"))
                    && node.attribute((ns, "name")) == Some("ref-findings")
            })
            .unwrap()
            .parent()
            .unwrap();
        let text: String = heading
            .descendants()
            .filter(|node| node.has_tag_name((ns, "t")))
            .filter_map(|node| node.text())
            .collect();
        assert_eq!(text, "[1] Findings");
        let _ = std::fs::remove_file(out);
    }

    #[test]
    fn docx_publishes_complete_zip_and_cleans_up_when_publication_fails() {
        let dir = tmp("atomic").with_extension("test-dir");
        std::fs::create_dir(&dir).unwrap();
        let out = dir.join("book.docx");
        let blocked = out.with_extension("blocked");
        std::fs::create_dir_all(&blocked).unwrap();
        std::fs::write(blocked.join("keep"), b"existing contents").unwrap();
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let widths = HashMap::new();
        let opts = DocxExportOptions {
            math: &math,
            diagrams: &diagrams,
            images: &images,
            style: None,
            page_numbers: false,
            table_widths: &widths,
            title: Some("Atomic export"),
            author: None,
            toc: false,
            lof: false,
            lot: false,
            header_title: None,
            highlight: None,
            comments: &[],
            front_lang: "en",
            columns: 1,
            footer_text: None,
        };
        assert!(export_docx("# New document", &opts, &blocked).is_err());
        assert_eq!(
            std::fs::read(blocked.join("keep")).unwrap(),
            b"existing contents"
        );
        assert!(!std::fs::read_dir(blocked.parent().unwrap())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".iyagi-tmp-")));

        std::fs::write(&out, b"old export").unwrap();
        export_docx("# New document", &opts, &out).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&out).unwrap()).unwrap();
        let mut document = String::new();
        use std::io::Read;
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut document)
            .unwrap();
        assert!(document.contains("New document"));
        assert!(zip.by_name("[Content_Types].xml").is_ok());
        drop(zip);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn basic_document_with_all_blocks() {
        let md = "# 제목\n\n**굵게**와 *기울임*, `code`, ~~취소~~.\n\n- 항목\n- [ ] 할 일\n\n1. 첫째\n\n> 인용\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```rust\nfn main() {}\n```\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("basic");
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
    fn lists_preserve_start_restart_continuations_tasks_and_footnotes() {
        let markdown = concat!(
            "3. outer-three\n\n   continuation\n\n   7) nested-seven\n   8) nested-eight\n4. outer-four\n\n",
            "separator\n\n1. restarted\n\n",
            "- [ ] open-task\n\n  task-continuation\n- [x] done-task\n- plain-item\n\n",
            "separator\n\n5) [x] ordered-task\n6) ordered-next\n\n",
            "> 9. quoted-nine\n\n",
            "- # heading-item\n\n  heading-continuation\n\n-\n\n",
            "note[^n]\n\n[^n]: note-text\n\n    6. note-six\n    7. note-seven\n",
        );
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("list-sequences");
        export_docx(
            markdown,
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "en",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut document = String::new();
        let mut numbering = String::new();
        let mut footnotes = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut document)
            .unwrap();
        zip.by_name("word/numbering.xml")
            .unwrap()
            .read_to_string(&mut numbering)
            .unwrap();
        zip.by_name("word/footnotes.xml")
            .unwrap()
            .read_to_string(&mut footnotes)
            .unwrap();
        let doc = roxmltree::Document::parse(&document).unwrap();
        let nums = roxmltree::Document::parse(&numbering).unwrap();
        let notes = roxmltree::Document::parse(&footnotes).unwrap();
        let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        let paragraph = |text: &str| {
            doc.descendants()
                .find(|node| {
                    node.has_tag_name((ns, "p"))
                        && node
                            .descendants()
                            .filter(|child| child.has_tag_name((ns, "t")))
                            .filter_map(|child| child.text())
                            .collect::<String>()
                            .trim()
                            == text
                })
                .unwrap()
        };
        let num_id = |node: roxmltree::Node<'_, '_>| {
            node.descendants()
                .find(|child| child.has_tag_name((ns, "numId")))
                .and_then(|child| child.attribute((ns, "val")))
                .map(str::to_string)
        };
        let instance = |id: &str| {
            nums.descendants()
                .find(|node| {
                    node.has_tag_name((ns, "num")) && node.attribute((ns, "numId")) == Some(id)
                })
                .unwrap()
        };
        let start = |id: &str| {
            instance(id)
                .descendants()
                .find(|node| node.has_tag_name((ns, "startOverride")))
                .unwrap()
                .attribute((ns, "val"))
                .unwrap()
                .parse::<usize>()
                .unwrap()
        };

        let outer = num_id(paragraph("outer-three")).unwrap();
        assert_eq!(num_id(paragraph("outer-four")), Some(outer.clone()));
        assert_eq!(start(&outer), 3);
        let nested = num_id(paragraph("nested-seven")).unwrap();
        assert_eq!(num_id(paragraph("nested-eight")), Some(nested.clone()));
        assert_ne!(nested, outer);
        assert_eq!(start(&nested), 7);
        assert!(paragraph("nested-seven").descendants().any(|node| node
            .has_tag_name((ns, "ilvl"))
            && node.attribute((ns, "val")) == Some("1")));
        let restarted = num_id(paragraph("restarted")).unwrap();
        assert_ne!(restarted, outer);
        assert_eq!(start(&restarted), 1);

        for text in ["continuation", "task-continuation", "heading-continuation"] {
            let p = paragraph(text);
            assert_eq!(num_id(p), None, "{text}");
            assert!(!p.descendants().any(|node| node.has_tag_name((ns, "sym"))));
            assert!(p.descendants().any(|node| node.has_tag_name((ns, "ind"))
                && node.attribute((ns, "left")) == Some("360")
                && node.attribute((ns, "firstLine")) == Some("0")));
        }
        for (text, symbol) in [("open-task", "F0A8"), ("done-task", "F0FE")] {
            let p = paragraph(text);
            assert_eq!(num_id(p), None);
            assert_eq!(
                p.descendants()
                    .filter(|node| node.has_tag_name((ns, "sym"))
                        && node.attribute((ns, "char")) == Some(symbol))
                    .count(),
                1
            );
        }
        assert!(num_id(paragraph("plain-item")).is_some());
        let ordered_task = num_id(paragraph("ordered-task")).unwrap();
        assert_eq!(start(&ordered_task), 5);
        assert_eq!(
            num_id(paragraph("ordered-next")),
            Some(ordered_task.clone())
        );
        assert!(paragraph("ordered-task")
            .descendants()
            .any(|node| node.has_tag_name((ns, "sym"))));
        let abstract_id = instance(&ordered_task)
            .children()
            .find(|node| node.has_tag_name((ns, "abstractNumId")))
            .unwrap()
            .attribute((ns, "val"))
            .unwrap();
        assert!(nums
            .descendants()
            .filter(|node| node.has_tag_name((ns, "abstractNum"))
                && node.attribute((ns, "abstractNumId")) == Some(abstract_id))
            .flat_map(|node| node.descendants())
            .any(|node| node.has_tag_name((ns, "lvlText"))
                && node.attribute((ns, "val")) == Some("%1)")));
        assert!(paragraph("quoted-nine")
            .descendants()
            .any(|node| node.has_tag_name((ns, "pStyle"))
                && node.attribute((ns, "val")) == Some("IYAGIQuote")));
        assert_eq!(start(&num_id(paragraph("quoted-nine")).unwrap()), 9);

        // The heading item and empty item each have a marker-only paragraph.
        let heading_marker = paragraph("heading-item").prev_sibling_element().unwrap();
        let heading_list = num_id(heading_marker).unwrap();
        assert_eq!(
            num_id(
                paragraph("heading-continuation")
                    .next_sibling_element()
                    .unwrap()
            ),
            Some(heading_list)
        );
        let note_ids: Vec<_> = notes
            .descendants()
            .filter(|node| node.has_tag_name((ns, "p")))
            .filter_map(num_id)
            .collect();
        assert_eq!(note_ids.len(), 2);
        assert_eq!(note_ids[0], note_ids[1]);
        assert_eq!(start(&note_ids[0]), 6);
        assert_ne!(note_ids[0], outer);
        // Every numbered paragraph has a concrete definition in the package.
        for xml in [&doc, &notes] {
            for id in xml
                .descendants()
                .filter(|node| node.has_tag_name((ns, "numId")))
            {
                instance(id.attribute((ns, "val")).unwrap());
            }
        }
        let _ = std::fs::remove_file(out);
    }

    #[test]
    fn page_break_macro_becomes_word_page_break() {
        let md = "앞\n\n\\newpage\n\n뒤";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("pagebreak");
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
        assert!(doc.contains("<w:br w:type=\"page\"/>"));
        assert!(!doc.contains("newpage"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn citations_become_anchors_and_bibliography() {
        let md = concat!(
            "# 연구\n\n`[@kim2020]`와 \\[@lee2021].\n\n",
            "````markdown\n```\n[@fake]: Fake.\n[@lee2021]\n````\n\n",
            "연구 [@kim2020]와 [@lee2021, p. 12].\n\n",
            "**[@kim2020]**와 [@가&\", p. < & \" ==literal==].\n\n",
            "[label [@kim2020]](https://example.com) $[@lee2021]$\n\n",
            "원문 \u{E001}kim2020\u{E003}\u{E001} 보존.\n\n",
            "각주[^cite].\n\n",
            "[@kim2020]: Old Kim.\n[@kim2020]: Kim (2020).\n",
            "[@lee2021]: Lee (2021).\n[@가&\"]: 특수 키 문헌.\n\n",
            "끊긴 [@ghost,  p. 1] 인용.\n\n[^cite]: 각주 속 [@lee2021].\n",
        );
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("cites");
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
        let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        let parsed = roxmltree::Document::parse(&doc).unwrap();
        let links: Vec<_> = parsed
            .descendants()
            .filter(|node| {
                node.has_tag_name((ns, "hyperlink")) && node.attribute((ns, "anchor")).is_some()
            })
            .collect();
        assert_eq!(links.len(), 4);
        let labels: Vec<String> = links
            .iter()
            .map(|node| {
                node.descendants()
                    .filter(|child| child.has_tag_name((ns, "t")))
                    .filter_map(|child| child.text())
                    .collect()
            })
            .collect();
        assert_eq!(
            labels,
            ["[1]", "[2, p. 12]", "[1]", "[3, p. < & \" ==literal==]"]
        );
        assert!(links[2]
            .descendants()
            .any(|node| node.has_tag_name((ns, "b"))));
        assert_eq!(links[3].attribute((ns, "anchor")), Some("ref-가&\""));
        assert!(!links[3]
            .descendants()
            .any(|node| node.has_tag_name((ns, "shd"))));
        for link in links {
            assert!(link.parent().unwrap().has_tag_name((ns, "p")));
            assert!(link
                .descendants()
                .any(|node| node.has_tag_name((ns, "vertAlign"))
                    && node.attribute((ns, "val")) == Some("superscript")));
            let target = link.attribute((ns, "anchor")).unwrap();
            assert_eq!(
                parsed
                    .descendants()
                    .filter(|node| node.has_tag_name((ns, "bookmarkStart"))
                        && node.attribute((ns, "name")) == Some(target))
                    .count(),
                1
            );
        }
        assert!(parsed
            .descendants()
            .filter(|node| node.has_tag_name((ns, "t")))
            .all(|node| node.children().all(|child| child.is_text())));
        assert!(doc.contains("[1] Old Kim."));
        assert!(doc.contains("[1] Kim (2020)."));
        assert!(doc.contains("[2] Lee (2021)."));
        assert!(doc.contains("[@ghost,  p. 1]"));
        assert!(doc.contains("\u{E001}kim2020\u{E003}\u{E001}"));
        assert!(doc.contains("[@fake]: Fake."));
        assert_bookmark_ids(&doc, 4);
        let mut notes = String::new();
        use std::io::Read;
        zip.by_name("word/footnotes.xml")
            .unwrap()
            .read_to_string(&mut notes)
            .unwrap();
        let notes = roxmltree::Document::parse(&notes).unwrap();
        let note_link = notes
            .descendants()
            .find(|node| node.has_tag_name((ns, "hyperlink")))
            .unwrap();
        assert_eq!(note_link.attribute((ns, "anchor")), Some("ref-lee2021"));
        assert!(note_link.parent().unwrap().has_tag_name((ns, "p")));
        assert!(note_link
            .descendants()
            .any(|node| node.text() == Some("[2]")));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn columns_become_sect_pr_cols() {
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("cols");
        export_docx(
            "# 제목\n\n본문",
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 2,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
        assert!(doc.contains(r#"<w:cols w:num="2" w:space="425"/>"#));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn footer_text_lands_in_footer_xml() {
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("footertxt");
        export_docx(
            "# 제목\n\n본문",
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: Some("기밀 <내부용>"),
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        let ftr = {
            let mut s = String::new();
            use std::io::Read;
            zip.by_name("word/footer1.xml")
                .unwrap()
                .read_to_string(&mut s)
                .unwrap();
            s
        };
        // 쪽번호 꺼짐 → 텍스트만, < >는 이스케이프.
        assert!(ftr.contains("기밀 &lt;내부용&gt;"));
        assert!(!ftr.contains("NUMPAGES"));
        // 문서도 바닥글 참조를 얻는다(page_numbers 없이도).
        let doc = {
            let mut s = String::new();
            use std::io::Read;
            zip.by_name("word/document.xml")
                .unwrap()
                .read_to_string(&mut s)
                .unwrap();
            s
        };
        assert!(doc.contains("rIdFooter"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn is_page_break_variants() {
        assert!(is_page_break("\\newpage"));
        assert!(is_page_break(" \\pagebreak "));
        assert!(is_page_break("\\page"));
        assert!(!is_page_break("\\newpage 주석"));
        assert!(!is_page_break("newpage"));
        assert!(!is_page_break(""));
    }

    #[test]
    fn anchor_links_and_heading_bookmarks() {
        let md = "# 개요\n\n[설치로](#설치) [인코딩](#%EC%84%A4%EC%B9%98) [특수문자](#x%22%26y).\n\n## 설치\n\n## 설치\n\n# A\n\n# A\n\n# A 1\n\n# **Strong** `code`\n\n[서식 제목](#strong-code)\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("anchor");
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
        assert!(doc.contains(r#"w:name="설치"/>"#));
        assert!(doc.contains(r#"w:name="설치-1""#));
        // 내부 링크는 관계가 아니라 anchor 속성으로.
        assert!(doc.contains(r#"<w:hyperlink w:anchor="설치">"#));
        assert_eq!(doc.matches(r#"<w:hyperlink w:anchor="설치">"#).count(), 2);
        assert!(doc.contains(r#"<w:hyperlink w:anchor="x&quot;&amp;y">"#));
        assert!(doc.contains(r#"w:name="strong-code"/>"#));
        assert!(doc.contains(r#"<w:hyperlink w:anchor="strong-code">"#));
        let xml = roxmltree::Document::parse(&doc).unwrap();
        let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        let names: Vec<_> = xml
            .descendants()
            .filter(|node| node.has_tag_name((ns, "bookmarkStart")))
            .map(|node| node.attribute((ns, "name")).unwrap())
            .collect();
        assert_eq!(
            names,
            ["개요", "설치", "설치-1", "a", "a-1", "a-1-1", "strong-code"]
        );
        assert_bookmark_ids(&doc, 7);
        assert!(!doc.contains("rIdH"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn footnotes_become_native_word_footnotes() {
        let md = concat!(
            "본문입니다[^b]. 다음[^a]. 반복[^b]. 미정[^missing].\n\n",
            "\\[^b]와 `[^b] ==literal==`.\n\n",
            "````markdown\n[^fake]: code definition\n[^b]\n```\nstill code\n````\n\n",
            "[^a]: Second note.\n\n",
            "[^b]: 각주 정의 **내용**와 [링크](https://example.org/note).\n",
            "    계속 줄.\n\n",
            "    두 번째 문단.\n\n",
            "    - 목록 항목\n\n",
            "    ```rust\n    let value = 1;\n    ```\n\n",
            "[^unused]: Unreferenced note.\n\n뒤 문단.\n",
        );
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("fn");
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
        let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        let document = roxmltree::Document::parse(&doc).unwrap();
        let refs: Vec<_> = document
            .descendants()
            .filter(|n| n.has_tag_name((ns, "footnoteReference")))
            .collect();
        assert_eq!(
            refs.iter()
                .map(|n| n.attribute((ns, "id")).unwrap())
                .collect::<Vec<_>>(),
            ["1", "2", "1"]
        );
        assert!(refs
            .iter()
            .all(|n| n.parent().is_some_and(|p| p.has_tag_name((ns, "r")))));
        assert!(refs
            .iter()
            .all(|n| !n.ancestors().any(|p| p.has_tag_name((ns, "t")))));
        let literal: String = document
            .descendants()
            .filter(|n| n.has_tag_name((ns, "t")))
            .filter_map(|n| n.text())
            .collect();
        assert!(literal.contains("[^fake]: code definition"));
        assert!(literal.contains("[^missing]"));
        assert!(literal.contains("[^b] ==literal=="));
        assert!(literal.contains("still code"));
        assert!(!doc.contains('\u{E000}'));

        let notes = roxmltree::Document::parse(&fns).unwrap();
        let first = notes
            .descendants()
            .find(|n| n.has_tag_name((ns, "footnote")) && n.attribute((ns, "id")) == Some("1"))
            .unwrap();
        assert!(first
            .descendants()
            .any(|n| n.has_tag_name((ns, "footnoteRef"))));
        assert!(
            first
                .descendants()
                .filter(|n| n.has_tag_name((ns, "p")))
                .count()
                >= 4
        );
        assert!(fns.contains("두 번째 문단"));
        assert!(fns.contains("목록 항목"));
        assert!(fns.contains("let value = 1;"));
        assert!(!fns.contains("Unreferenced note"));
        let note_rels = read(&mut zip, "word/_rels/footnotes.xml.rels");
        assert!(note_rels.contains("https://example.org/note"));
        let rel_doc = roxmltree::Document::parse(&note_rels).unwrap();
        let rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        for link in first
            .descendants()
            .filter(|n| n.has_tag_name((ns, "hyperlink")))
        {
            let id = link.attribute((rel_ns, "id")).unwrap();
            assert!(rel_doc.descendants().any(|n| n.attribute("Id") == Some(id)));
        }
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
        assert_drawing_paragraph_structure(&doc, 1);
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
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
            0, 0, 0, 100, 0, 0, 0, 40, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0A, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9C, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0D, 0x0A, 0x2D, 0xB4, 0, 0, 0, 0, 0x49,
            0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
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
                    lof: false,
                    lot: false,
                    header_title: None,
                    highlight: None,
                    comments: &[],
                    front_lang: "ko",
                    columns: 1,
                    footer_text: None,
                },
                &out,
            )
            .unwrap();
            let bytes = std::fs::read(&out).unwrap();
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
            use std::io::Read;
            let mut doc = String::new();
            zip.by_name("word/document.xml")
                .unwrap()
                .read_to_string(&mut doc)
                .unwrap();
            let _ = std::fs::remove_file(&out);
            (doc, String::new())
        };

        let (full, _) = read_doc(None);
        let (half, _) = read_doc(Some(50));
        let ext_of = |doc: &str| -> i64 {
            let m = doc
                .split("cx=\"")
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap();
            m.parse().unwrap()
        };
        let f = ext_of(&full);
        let h = ext_of(&half);
        assert!(f > 0);
        // 50% 지정이면 폭이 정확히 절반(반올림 ±1 EMU).
        assert!(
            (f as f64 / 2.0 - h as f64).abs() <= 1.0,
            "full={f} half={h}"
        );
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
        export_docx(
            md,
            &DocxExportOptions {
                math: &math,
                diagrams: &diagrams,
                images: &images,
                style: None,
                page_numbers: false,
                table_widths: &widths,
                title: None,
                author: None,
                toc: false,
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        // 비율 1:3 → 8640을 2160/6480으로 분할.
        assert!(doc.contains("<w:gridCol w:w=\"2160\"/>"));
        assert!(doc.contains("<w:gridCol w:w=\"6480\"/>"));
        assert!(doc.contains("<w:tcW w:w=\"2160\""));
        assert!(doc.contains("<w:tcW w:w=\"6480\""));
        // 지정 없는 표는 균등(4320).
        let out2 = tmp("tblw-even");
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out2,
        )
        .unwrap();
        let bytes2 = std::fs::read(&out2).unwrap();
        let mut z2 = zip::ZipArchive::new(std::io::Cursor::new(&bytes2)).unwrap();
        let mut doc2 = String::new();
        z2.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc2)
            .unwrap();
        assert!(doc2.contains("<w:gridCol w:w=\"4320\"/>"));
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&out2);
    }

    #[test]
    fn lof_lot_fields() {
        let md = "![설명](a.png)\n\n| a |\n|---|\n| 1 |\n: 캡션\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let out = tmp("loflot");
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
                lof: true,
                lot: true,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        assert!(doc.contains("그림 목차"));
        assert!(doc.contains("\\c \"Figure\""));
        assert!(doc.contains("표 목차"));
        assert!(doc.contains("\\c \"Table\""));
        // 그림 목차가 본문(그림) 앞에.
        assert!(doc.find("그림 목차").unwrap() < doc.find("설명").unwrap());
        let mut st = String::new();
        zip.by_name("word/settings.xml")
            .unwrap()
            .read_to_string(&mut st)
            .unwrap();
        assert!(st.contains("updateFields")); // 필드 갱신도 켜짐
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn comments_export_native() {
        let md = "# Heading\n\nFirst line\ncontinued\n\n- Item\n\n> Quote\n\n| H | V |\n|---|---|\n| Cell | value |\n\n```\ncode one\ncode two\n```\n\n[^a]: note\n    continuation\n\nAfter footnote[^a]\n\n<div>raw</div>\n";
        let math = HashMap::new();
        let diagrams = HashMap::new();
        let images = ImageSource::new(String::new());
        let comments: Vec<(u32, String)> = [
            (1, "검토 필요"),
            (1, "Second <review> & note"),
            (4, "continuation"),
            (6, "list"),
            (8, "quote"),
            (12, "table"),
            (16, "code"),
            (22, "after footnote"),
            (24, "raw HTML"),
            (2, "blank line"),
            (19, "footnote definition"),
        ]
        .into_iter()
        .map(|(line, text)| (line, text.to_string()))
        .collect();
        let out = tmp("cmt");
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &comments,
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        assert!(doc.contains("<w:commentRangeStart w:id=\"1\"/>"));
        assert!(doc.contains("<w:commentReference w:id=\"1\"/>"));
        let mut cm = String::new();
        zip.by_name("word/comments.xml")
            .unwrap()
            .read_to_string(&mut cm)
            .unwrap();
        assert!(cm.contains("검토 필요"));
        assert!(cm.contains("w:author=\"IYAGI Markdown\""));
        let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        let document = roxmltree::Document::parse(&doc).unwrap();
        let definitions = roxmltree::Document::parse(&cm).unwrap();
        assert_eq!(
            definitions
                .descendants()
                .filter(|n| n.has_tag_name((ns, "comment")))
                .count(),
            comments.len()
        );
        for (index, (_, note)) in comments.iter().enumerate() {
            let id = (index + 1).to_string();
            for tag in ["commentRangeStart", "commentRangeEnd", "commentReference"] {
                assert_eq!(
                    document
                        .descendants()
                        .filter(|n| n.has_tag_name((ns, tag))
                            && n.attribute((ns, "id")) == Some(id.as_str()))
                        .count(),
                    1,
                    "{tag}: {id}"
                );
            }
            let definition = definitions
                .descendants()
                .find(|n| {
                    n.has_tag_name((ns, "comment")) && n.attribute((ns, "id")) == Some(id.as_str())
                })
                .unwrap();
            let text: String = definition
                .descendants()
                .filter(|n| n.is_text())
                .filter_map(|n| n.text())
                .collect();
            assert_eq!(text, *note);
        }
        for (id, expected) in [
            ("1", "Heading"),
            ("2", "Heading"),
            ("3", "continued"),
            ("4", "Item"),
            ("5", "Quote"),
            ("6", "Cell"),
            ("7", "code two"),
            ("8", "After footnote"),
            ("9", ""),
            ("10", ""),
            ("11", ""),
        ] {
            let reference = document
                .descendants()
                .find(|n| {
                    n.has_tag_name((ns, "commentReference")) && n.attribute((ns, "id")) == Some(id)
                })
                .unwrap();
            let paragraph = reference
                .ancestors()
                .find(|n| n.has_tag_name((ns, "p")))
                .unwrap();
            let text: String = paragraph
                .descendants()
                .filter(|n| n.has_tag_name((ns, "t")))
                .filter_map(|n| n.text())
                .collect();
            if expected.is_empty() {
                assert_eq!(text, "");
            } else {
                assert!(text.contains(expected), "{id}: {text}");
            }
        }
        let mut ct = String::new();
        zip.by_name("[Content_Types].xml")
            .unwrap()
            .read_to_string(&mut ct)
            .unwrap();
        assert!(ct.contains("/word/comments.xml"));
        // 메모 없으면 파트도 없다.
        let out2 = tmp("cmt-none");
        export_docx(
            "본문\n",
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out2,
        )
        .unwrap();
        let b2 = std::fs::read(&out2).unwrap();
        let z2 = zip::ZipArchive::new(std::io::Cursor::new(&b2)).unwrap();
        assert!(z2
            .file_names()
            .filter_map(|n| n.ok())
            .all(|n| n != "word/comments.xml"));
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
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
                    lof: false,
                    lot: false,
                    header_title: None,
                    highlight: hl,
                    comments: &[],
                    front_lang: "ko",
                    columns: 1,
                    footer_text: None,
                },
                &out,
            )
            .unwrap();
            let bytes = std::fs::read(&out).unwrap();
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
            use std::io::Read;
            let mut doc = String::new();
            zip.by_name("word/document.xml")
                .unwrap()
                .read_to_string(&mut doc)
                .unwrap();
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        // 모든 하이퍼링크 런에 rStyle Hyperlink — 굵게 런(rPr 기존)도 겹침 없이.
        assert!(doc.matches("w:rStyle w:val=\"Hyperlink\"").count() >= 2);
        assert!(!doc.contains("</w:rPr><w:rPr>"), "rPr 중복 없음");
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn figure_captions_seq_and_guards() {
        let png: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 0x0A, 0x49,
            0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0D, 0x0A, 0x2D, 0xB4, 0, 0,
            0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let dir = std::env::temp_dir().join(format!("md-export-fig-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.png"), &png).unwrap();
        std::fs::write(dir.join("b.png"), &png).unwrap();
        std::fs::write(dir.join("shape.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="blue"/></svg>"#).unwrap();
        let md = concat!(
            "앞 ![*실험* `설정도`](a.png) 중간 [![연결 설명](b.png)](https://example.com) 뒤[^note].\n\n",
            "![screenshot.png](b.png)\n\n",
            "- 목록 ![목록 설명](a.png) 끝\n\n",
            "| 그림 | 값 |\n|---|---|\n| ![셀 설명](a.png) | 값 |\n\n",
            "# 제목 ![제목 설명](a.png)\n\n",
            "> 인용 ![인용 설명](a.png)\n\n",
            "[@source]: 서지 ![서지 설명](a.png)\n\n",
            "벡터 앞 ![벡터 설명](shape.svg) 벡터 뒤\n\n",
            "![**누락** `그림`](missing.png)\n\n",
            "[^note]: 각주 ![각주 설명](a.png) 끝\n",
        );
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        // Filename alt and missing images do not create captions.
        assert!(doc.contains(" SEQ Figure \\* ARABIC "));
        assert!(doc.contains("그림 </w:t>"));
        assert!(doc.contains(" — 실험 설정도"));
        assert_eq!(doc.matches("SEQ Figure").count(), 8);
        assert!(doc.contains("[누락 그림]"));
        assert_drawing_paragraph_structure(&doc, 9);
        let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        let xml = roxmltree::Document::parse(&doc).unwrap();
        let captions: Vec<_> = xml
            .descendants()
            .filter(|node| {
                node.has_tag_name((ns, "p"))
                    && node.descendants().any(|child| {
                        child.has_tag_name((ns, "pStyle"))
                            && child.attribute((ns, "val")) == Some("Caption")
                    })
            })
            .collect();
        let descriptions: Vec<_> = captions
            .iter()
            .map(|caption| {
                caption
                    .descendants()
                    .filter(|node| node.has_tag_name((ns, "t")))
                    .filter_map(|node| node.text())
                    .find(|text| text.starts_with(" — "))
                    .unwrap()
            })
            .collect();
        assert_eq!(
            descriptions,
            [
                " — 실험 설정도",
                " — 연결 설명",
                " — 목록 설명",
                " — 셀 설명",
                " — 제목 설명",
                " — 인용 설명",
                " — 서지 설명",
                " — 벡터 설명"
            ]
        );
        for (index, caption) in captions.iter().enumerate() {
            assert!(caption
                .parent()
                .unwrap()
                .has_tag_name((ns, if index == 3 { "tc" } else { "body" })));
            assert!(!caption.descendants().any(
                |node| node.has_tag_name((ns, "hyperlink")) || node.has_tag_name((ns, "numPr"))
            ));
        }
        let inline_paragraph = captions[0].prev_sibling_element().unwrap();
        let inline_text: String = inline_paragraph
            .descendants()
            .filter(|node| node.has_tag_name((ns, "t")))
            .filter_map(|node| node.text())
            .collect();
        assert_eq!(inline_text, "앞  중간  뒤.");
        assert_eq!(
            inline_paragraph
                .descendants()
                .filter(|node| node.has_tag_name((ns, "drawing")))
                .count(),
            2
        );
        assert!(inline_paragraph
            .descendants()
            .any(|node| node.has_tag_name((ns, "hyperlink"))
                && node
                    .descendants()
                    .any(|child| child.has_tag_name((ns, "drawing")))));
        assert_eq!(captions[1].prev_sibling_element(), Some(captions[0]));

        let mut notes = String::new();
        zip.by_name("word/footnotes.xml")
            .unwrap()
            .read_to_string(&mut notes)
            .unwrap();
        assert_drawing_paragraph_structure(&notes, 1);
        let notes_xml = roxmltree::Document::parse(&notes).unwrap();
        let note_caption = notes_xml
            .descendants()
            .find(|node| {
                node.has_tag_name((ns, "p"))
                    && node
                        .descendants()
                        .any(|child| child.text() == Some(" — 각주 설명"))
            })
            .unwrap();
        assert!(note_caption
            .parent()
            .unwrap()
            .has_tag_name((ns, "footnote")));
        assert!(note_caption
            .prev_sibling_element()
            .unwrap()
            .descendants()
            .any(|node| node.has_tag_name((ns, "drawing"))));
        assert_eq!(notes.matches("SEQ Figure").count(), 1);
        // A bibliography image must be rendered once, including its media entry.
        assert_eq!(
            zip.file_names()
                .map(|name| name.unwrap())
                .filter(|name| name.starts_with("word/media/"))
                .count(),
            9
        );
        let mut styles = String::new();
        zip.by_name("word/styles.xml")
            .unwrap()
            .read_to_string(&mut styles)
            .unwrap();
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
                    lof: false,
                    lot: false,
                    highlight: None,
                    comments: &[],
                    front_lang: "ko",
                    columns: 1,
                    footer_text: None,
                    header_title: header,
                },
                &out,
            )
            .unwrap();
            let bytes = std::fs::read(&out).unwrap();
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
            use std::io::Read;
            let entry = |zip: &mut zip::ZipArchive<std::io::Cursor<&Vec<u8>>>, name: &str| match zip
                .by_name(name)
            {
                Ok(mut z) => {
                    let mut s = String::new();
                    z.read_to_string(&mut s).unwrap();
                    s
                }
                Err(_) => String::new(),
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
                    lof: false,
                    lot: false,
                    header_title: None,
                    highlight: None,
                    comments: &[],
                    front_lang: "ko",
                    columns: 1,
                    footer_text: None,
                },
                &out,
            )
            .unwrap();
            let bytes = std::fs::read(&out).unwrap();
            let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
            use std::io::Read;
            let mut doc = String::new();
            zip.by_name("word/document.xml")
                .unwrap()
                .read_to_string(&mut doc)
                .unwrap();
            let mut settings = String::new();
            zip.by_name("word/settings.xml")
                .unwrap()
                .read_to_string(&mut settings)
                .unwrap();
            let mut styles = String::new();
            zip.by_name("word/styles.xml")
                .unwrap()
                .read_to_string(&mut styles)
                .unwrap();
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        use std::io::Read;
        let mut core = String::new();
        zip.by_name("docProps/core.xml")
            .unwrap()
            .read_to_string(&mut core)
            .unwrap();
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out2,
        )
        .unwrap();
        let bytes2 = std::fs::read(&out2).unwrap();
        let mut z2 = zip::ZipArchive::new(std::io::Cursor::new(&bytes2)).unwrap();
        let mut core2 = String::new();
        z2.by_name("docProps/core.xml")
            .unwrap()
            .read_to_string(&mut core2)
            .unwrap();
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
        export_docx(
            md,
            &DocxExportOptions {
                math: &math,
                diagrams: &diagrams,
                images: &images,
                style: None,
                page_numbers: true,
                table_widths: &HashMap::new(),
                title: None,
                author: None,
                toc: false,
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        use std::io::Read;
        // 바닥글 파트 + 필드 명령.
        let mut ftr = String::new();
        zip.by_name("word/footer1.xml")
            .unwrap()
            .read_to_string(&mut ftr)
            .unwrap();
        assert!(ftr.contains(" PAGE "));
        assert!(ftr.contains(" NUMPAGES "));
        assert!(ftr.contains("<w:jc w:val=\"center\"/>"));
        // 문서 섹션 → 바닥글 참조.
        let mut doc = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        assert!(doc.contains("<w:footerReference w:type=\"default\" r:id=\"rIdFooter\"/>"));
        // 관계·콘텐츠 타입.
        let mut rels = String::new();
        zip.by_name("word/_rels/document.xml.rels")
            .unwrap()
            .read_to_string(&mut rels)
            .unwrap();
        assert!(rels.contains("Id=\"rIdFooter\"") && rels.contains("Target=\"footer1.xml\""));
        let mut ct = String::new();
        zip.by_name("[Content_Types].xml")
            .unwrap()
            .read_to_string(&mut ct)
            .unwrap();
        assert!(ct.contains("/word/footer1.xml"));
        // 끄면 아예 없다.
        let out2 = tmp("footer-off");
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out2,
        )
        .unwrap();
        let bytes2 = std::fs::read(&out2).unwrap();
        let z2 = zip::ZipArchive::new(std::io::Cursor::new(&bytes2)).unwrap();
        assert!(z2
            .file_names()
            .filter_map(|n| n.ok())
            .all(|n| n != "word/footer1.xml"));
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&out2);
    }

    #[test]
    fn webp_detected_with_dimensions() {
        // VP8X(확장) 캔버스 — w-1=111(→112), h-1=59(→60) 24비트 LE.
        let mut vp8x = Vec::new();
        vp8x.extend_from_slice(b"RIFF");
        vp8x.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // RIFF 크기(내보내기 불문)
        vp8x.extend_from_slice(b"WEBP");
        vp8x.extend_from_slice(b"VP8X");
        vp8x.extend_from_slice(&10u32.to_le_bytes()); // 청크 길이
        vp8x.push(0); // 플래그
        vp8x.extend_from_slice(&[0, 0, 0]); // 예약
        vp8x.extend_from_slice(&[111, 0, 0]); // w-1
        vp8x.extend_from_slice(&[59, 0, 0]); // h-1
        assert_eq!(detect_image(&vp8x), Some("webp"));
        assert_eq!(image_dimensions(&vp8x), Some((112, 60)));

        // VP8L(무손실) — 시그니처 0x2F 뒤 32비트 LE: w-1=199, h-1=99.
        let mut vp8l = Vec::new();
        vp8l.extend_from_slice(b"RIFF");
        vp8l.extend_from_slice(&[0, 0, 0, 0]);
        vp8l.extend_from_slice(b"WEBP");
        vp8l.extend_from_slice(b"VP8L");
        vp8l.extend_from_slice(&5u32.to_le_bytes());
        vp8l.push(0x2F);
        let v: u32 = 199 | (99 << 14);
        vp8l.extend_from_slice(&v.to_le_bytes());
        while vp8l.len() < 30 {
            vp8l.push(0);
        }
        assert_eq!(detect_image(&vp8l), Some("webp"));
        assert_eq!(image_dimensions(&vp8l), Some((200, 100)));
    }

    #[test]
    fn mixed_drawings_share_ids_and_resolve_encoded_media_in_each_part() {
        // 최소 VP8X webp가 매체로 들어가고 [Content_Types]에 image/webp가 등록된다.
        let mut webp = Vec::new();
        webp.extend_from_slice(b"RIFF");
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(b"VP8X");
        webp.extend_from_slice(&10u32.to_le_bytes());
        webp.push(0);
        webp.extend_from_slice(&[0, 0, 0]);
        webp.extend_from_slice(&[111, 0, 0]);
        webp.extend_from_slice(&[59, 0, 0]);
        let dir = std::env::temp_dir().join(format!("md-export-webp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("pic #?%20.webp");
        std::fs::write(&img, &webp).unwrap();
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="blue"/></svg>"#;
        std::fs::write(dir.join("shape name.SVG"), svg).unwrap();
        std::fs::write(dir.join("broken.svg"), "not an SVG").unwrap();
        let md = concat!(
            "![사진](pic%20%23%3F%2520.webp?download=1#preview)\n\n",
            "![벡터](shape%20name.SVG#shape)\n\n",
            "```mermaid\nflowchart LR\nA-->B\n```\n\n",
            "![잘못된 SVG](broken.svg)\n\n",
            "![반복](pic%20%23%3F%2520.webp)\n\n본문[^image].\n\n",
            "[^image]: ![각주 벡터](shape%20name.SVG?version=2#shape) ![각주 그림](pic%20%23%3F%2520.webp)\n",
        );
        let math = HashMap::new();
        let diagrams = HashMap::from([("flowchart LR\nA-->B".into(), svg.into())]);
        let images = ImageSource::new(dir.to_string_lossy().into_owned());
        let out = tmp("webp");
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
                lof: false,
                lot: false,
                header_title: None,
                highlight: None,
                comments: &[],
                front_lang: "ko",
                columns: 1,
                footer_text: None,
            },
            &out,
        )
        .unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        use std::io::Read;
        let mut doc = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut doc)
            .unwrap();
        assert!(
            doc.contains("r:embed=\"rIdImg"),
            "webp 이미지가 문서에 없다"
        );
        assert!(doc.contains("[잘못된 SVG]"));
        let mut ct = String::new();
        zip.by_name("[Content_Types].xml")
            .unwrap()
            .read_to_string(&mut ct)
            .unwrap();
        assert!(ct.contains("Extension=\"webp\"") && ct.contains("image/webp"));
        // Body and footnotes share drawing IDs, while media relationships have
        // their own sequence unaffected by interleaved SVG/Mermaid drawings
        // and the reserved drawing ID of a failed SVG conversion.
        let rel_ns = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        let drawing_ns = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
        let mut drawing_ids = Vec::new();
        let mut media_ids = Vec::new();
        for (part, relationships, expected_drawings, expected_media) in [
            ("word/document.xml", "word/_rels/document.xml.rels", 4, 2),
            ("word/footnotes.xml", "word/_rels/footnotes.xml.rels", 2, 1),
        ] {
            let mut xml = String::new();
            zip.by_name(part).unwrap().read_to_string(&mut xml).unwrap();
            let mut rels = String::new();
            zip.by_name(relationships)
                .unwrap()
                .read_to_string(&mut rels)
                .unwrap();
            let content = roxmltree::Document::parse(&xml).unwrap();
            let rels = roxmltree::Document::parse(&rels).unwrap();
            assert_drawing_paragraph_structure(&xml, expected_drawings);
            drawing_ids.extend(
                content
                    .descendants()
                    .filter(|node| node.has_tag_name((drawing_ns, "docPr")))
                    .map(|node| node.attribute("id").unwrap().parse::<u32>().unwrap()),
            );
            let ids: Vec<_> = content
                .descendants()
                .filter_map(|n| n.attribute((rel_ns, "embed")))
                .collect();
            assert_eq!(ids.len(), expected_media);
            for id in ids {
                media_ids.push(id.to_string());
                let target = rels
                    .descendants()
                    .find(|n| n.attribute("Id") == Some(id))
                    .and_then(|n| n.attribute("Target"))
                    .unwrap();
                let mut media = Vec::new();
                zip.by_name(&format!("word/{target}"))
                    .unwrap()
                    .read_to_end(&mut media)
                    .unwrap();
                assert_eq!(media, webp, "{part}: {id}");
            }
        }
        drawing_ids.sort_unstable();
        assert_eq!(drawing_ids, [1, 2, 3, 4, 5, 7]);
        media_ids.sort();
        assert_eq!(media_ids, ["rIdImg1", "rIdImg2", "rIdImg3"]);
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
