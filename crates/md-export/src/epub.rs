//! EPUB 3 내보내기 — 최소 유효 패키지(mimetype·container·OPF·nav·챕터·CSS).
//! 콘텐츠(XHTML 본문)는 호출자가 넘기고 여기서는 조립과 zip만
//! (DOCX와 같은 원칙: 바깥 쪽 변환은 프런트가, 포장은 Rust가).
//! 1단계(이 모듈): 단일/다중 챕터 + 목차. 이미지·표지·챕터 자동 분할은 다음 단계.

use std::io::Write;
use std::path::Path;

/// 챕터 하나 — file은 "chapter1.xhtml" 같은 OEBPS 상대 이름.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubChapter {
    pub title: String,
    /// 챕터 본문 XHTML(<body> 안쪽 — 이미 이스케이프/정규화된 것).
    pub body: String,
    pub file: String,
    /// 챕터 안 h2 섹션(앵커, 제목) — EPUB 목차 depth용.
    #[serde(default)]
    pub sections: Vec<EpubSection>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpubSection {
    pub anchor: String,
    pub title: String,
}

pub struct EpubOptions {
    pub title: String,
    pub author: String,
    /// "ko" / "en".
    pub language: String,
    pub chapters: Vec<EpubChapter>,
    pub css: String,
    /// 표지 이미지 파일 경로(문서의 첫 이미지를 프런트가 고른다). 없으면 생략.
    pub cover_path: Option<String>,
    /// 챕터 본문 이미지 상대경로 해석 기준(문서 폴더).
    pub base_dir: String,
}

/// url이 스킴(http:·data:·mailto: …)을 가지는지 — 첫 '/' 세그먼트 안의 ':'.
fn has_scheme(url: &str) -> bool {
    url.split('/').next().unwrap_or("").contains(':')
}

/// %XX 퍼센트 디코딩(이미지 경로 정규화용 최소 구현).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let hex = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 챕터 본문의 로컬 이미지 src를 zip 내부 images/ 경로로 재작성한 본문 반환.
/// 읽은 파일은 files에 (href, media-type, bytes)로 쌓는다 — 같은 경로는 한 번만.
/// 원격(data:·http:·mailto:)·앵커는 그대로 두고, 읽기 실패 경로도 원본 유지.
fn embed_body_images(
    body: &str,
    base_dir: &str,
    seen: &mut std::collections::HashMap<String, String>,
    files: &mut Vec<(String, String, Vec<u8>)>,
) -> String {
    let src = crate::ImageSource::new(base_dir.to_string());
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(at) = rest.find("src=\"") {
        let start = at + 5;
        let Some(rel) = rest[start..].find('"') else { break };
        let end = start + rel;
        out.push_str(&rest[..start]);
        let url = &rest[start..end];
        let tail = &rest[end..];
        let local = !has_scheme(url) && !url.starts_with('#');
        let decoded = percent_decode(&url.replace('\\', "/"));
        // 중복 판정은 어휘 정규화된 절대경로 — "assets/a.png"와 "./assets/a.png"가 같은 파일로.
        let resolved = if local {
            Some(src.resolve(&decoded).to_string_lossy().into_owned())
        } else {
            None
        };
        let rewritten = if !local {
            None
        } else if let Some(href) = resolved.as_ref().and_then(|r| seen.get(r)) {
            Some(href.clone())
        } else {
            let ext = std::path::Path::new(&decoded)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_else(|| "png".into());
            let media = match ext.as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "svg" => "image/svg+xml",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                _ => "image/png",
            };
            src.read(&decoded).map(|bytes| {
                let href = format!("images/img{}.{ext}", files.len() + 1);
                seen.insert(resolved.unwrap_or_default(), href.clone());
                files.push((href.clone(), media.to_string(), bytes));
                href
            })
        };
        match rewritten {
            Some(href) => out.push_str(&href),
            None => out.push_str(url),
        }
        rest = tail;
    }
    out.push_str(rest);
    out
}

fn esc(s: &str) -> String {
    crate::xml::esc(s)
}

/// 결정적 유사 UUID(제목+내용 해시+시각) — 판별용 식별자.
fn pseudo_uuid(title: &str, seed: u128) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in title.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    for b in seed.to_le_bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:08x}-{:04x}-4{:03x}-a{:03x}-{h:012x}", (h >> 32) & 0xffff, h & 0xfff, (h >> 16) & 0xfff)
}

fn now_iso() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs();
    let ms = d.subsec_millis();
    // 유닉스 초 → UTC 달력(단순 산술, 1970~9999 범위에서 정확).
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let mut year = 1970i64;
    let mut day = days as i64;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let len = if leap { 366 } else { 365 };
        if day < len {
            break;
        }
        day -= len;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_lens = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for &ml in &month_lens {
        if day < ml {
            break;
        }
        day -= ml;
        month += 1;
    }
    format!("{year:04}-{month:02}-{:02}T{hh:02}:{mm:02}:{ss:02}.{ms:03}Z", day + 1)
}

fn xhtml_doc(title: &str, lang: &str, body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" lang=\"{lang}\" xml:lang=\"{lang}\"><head><meta charset=\"utf-8\"/><title>{}</title><link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/></head><body>{body}</body></html>",
        esc(title)
    )
}

/// EPUB 조립·zip 저장. mimetype은 반드시 첫 파일·무압축(규격 요건).
pub fn export_epub(opts: &EpubOptions, out: &Path) -> Result<(), String> {
    if opts.chapters.is_empty() {
        return Err("EPUB: 챕터가 없습니다".into());
    }
    let file = std::fs::File::create(out).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let stored: zip::write::SimpleFileOptions =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated: zip::write::SimpleFileOptions =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("mimetype", stored).map_err(|e| e.to_string())?;
    zip.write_all(b"application/epub+zip").map_err(|e| e.to_string())?;

    let add = |zip: &mut zip::ZipWriter<std::fs::File>, name: &str, data: &str| {
        zip.start_file(name, deflated).map_err(|e| e.to_string())?;
        zip.write_all(data.as_bytes()).map_err(|e| e.to_string())
    };

    add(
        &mut zip,
        "META-INF/container.xml",
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>",
    )?;

    let uuid = pseudo_uuid(
        &opts.title,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    );
    let modified = now_iso();

    // 표지 — 문서 첫 이미지. cover-image 속성으로 리더기 표지로 쓰인다.
    let mut cover_manifest = String::new();
    let mut cover_spine = String::new();
    let mut cover_nav_first = String::new();
    if let Some(cp) = &opts.cover_path {
        if let Ok(bytes) = std::fs::read(cp) {
            let ext = std::path::Path::new(cp)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_else(|| "png".into());
            let media = match ext.as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "svg" => "image/svg+xml",
                "webp" => "image/webp",
                _ => "image/png",
            };
            zip.start_file("OEBPS/cover-image", deflated).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
            cover_manifest = format!(
                "\n<item id=\"cover-image\" href=\"cover-image\" media-type=\"{media}\" properties=\"cover-image\"/>\
\n<item id=\"coverpage\" href=\"cover.xhtml\" media-type=\"application/xhtml+xml\"/>"
            );
            cover_spine = "<itemref idref=\"coverpage\"/>".to_string();
            let cover_body = format!(
                "<div class=\"cover-page\"><img src=\"cover-image\" alt=\"{}\"/></div>",
                esc(&opts.title)
            );
            cover_nav_first = format!(
                "<li><a href=\"cover.xhtml\">{}</a></li>\n",
                esc(&opts.title)
            );
            add(
                &mut zip,
                "OEBPS/cover.xhtml",
                &xhtml_doc(&opts.title, &opts.language, &cover_body),
            )?;
        }
    }

    // nav.xhtml — EPUB3 목차.
    let nav_items: String = opts
        .chapters
        .iter()
        .map(|c| {
            let head = format!("<li><a href=\"{}\">{}</a>", c.file, esc(&c.title));
            if c.sections.is_empty() {
                format!("{head}</li>")
            } else {
                let subs: String = c
                    .sections
                    .iter()
                    .map(|sec| {
                        format!(
                            "<li><a href=\"{}#{}\">{}</a></li>",
                            c.file,
                            esc(&sec.anchor),
                            esc(&sec.title)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                format!("{head}<ol>\n{subs}\n</ol></li>")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let nav_items = format!("{cover_nav_first}{nav_items}");
    let nav = xhtml_doc(
        &opts.title,
        &opts.language,
        &format!("<nav epub:type=\"toc\" id=\"toc\"><h1>{}</h1><ol>\n{nav_items}\n</ol></nav>", esc(&opts.title)),
    );
    add(&mut zip, "OEBPS/nav.xhtml", &nav)?;

    // 챕터들 — 본문 로컬 이미지를 zip 안 images/ 로 임베드(중복 제거).
    let mut img_seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut img_files: Vec<(String, String, Vec<u8>)> = Vec::new();
    let bodies: Vec<String> = opts
        .chapters
        .iter()
        .map(|c| embed_body_images(&c.body, &opts.base_dir, &mut img_seen, &mut img_files))
        .collect();
    for (c, body) in opts.chapters.iter().zip(&bodies) {
        add(&mut zip, &format!("OEBPS/{}", c.file), &xhtml_doc(&c.title, &opts.language, body))?;
    }
    for (href, _media, bytes) in &img_files {
        zip.start_file(format!("OEBPS/{href}"), deflated).map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())?;
    }
    add(&mut zip, "OEBPS/style.css", &opts.css)?;

    // content.opf — 메타데이터·매니페스트·스파인.
    let mut manifest = String::from(&format!(
        "<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n<item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>{cover_manifest}"
    ));
    let mut spine = cover_spine;
    for (i, c) in opts.chapters.iter().enumerate() {
        manifest.push_str(&format!(
            "\n<item id=\"ch{}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>",
            i + 1,
            c.file
        ));
        spine.push_str(&format!("\n<itemref idref=\"ch{}\"/>", i + 1));
    }
    // 임베드된 본문 이미지 — 매니페스트에 각각 등록(EPUB 유효성 요건).
    for (i, (href, media, _)) in img_files.iter().enumerate() {
        manifest.push_str(&format!(
            "\n<item id=\"img{}\" href=\"{href}\" media-type=\"{media}\"/>",
            i + 1
        ));
    }
    let opf = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"pub-id\"><metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:identifier id=\"pub-id\">urn:uuid:{uuid}</dc:identifier><dc:title>{}</dc:title><dc:creator>{}</dc:creator><dc:language>{}</dc:language><meta property=\"dcterms:modified\">{modified}</meta></metadata><manifest>{manifest}</manifest><spine>{spine}</spine></package>",
        esc(&opts.title),
        esc(&opts.author),
        esc(&opts.language)
    );
    add(&mut zip, "OEBPS/content.opf", &opf)?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("md-export-epub-{tag}-{}.epub", std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn read_entry(path: &Path, name: &str) -> String {
        let bytes = std::fs::read(path).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        use std::io::Read;
        let mut s = String::new();
        zip.by_name(name).unwrap().read_to_string(&mut s).unwrap();
        s
    }

    fn opts() -> EpubOptions {
        EpubOptions {
            title: "테스트 책".into(),
            author: "iyagi".into(),
            language: "ko".into(),
            css: "body{font-family:sans-serif}".into(),
            cover_path: None,
            base_dir: String::new(),
            chapters: vec![
                EpubChapter {
                    title: "첫 장".into(),
                    body: "<h1>첫 장</h1><p>내용 <mark>강조</mark></p>".into(),
                    file: "chapter1.xhtml".into(),
                    sections: vec![EpubSection {
                        anchor: "s1".into(),
                        title: "하위 절".into(),
                    }],
                },
                EpubChapter {
                    title: "둘째 장 <태그>".into(),
                    body: "<p>둘째</p>".into(),
                    file: "chapter2.xhtml".into(),
                    sections: vec![],
                },
            ],
        }
    }

    #[test]
    fn minimal_valid_epub() {
        let out = tmp("basic");
        export_epub(&opts(), &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        assert_eq!(&bytes[0..2], b"PK");
        // mimetype은 첫 엔트리이고 내용이 정확해야 한다.
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        let first = zip.by_index(0).unwrap();
        assert_eq!(first.name().unwrap(), "mimetype");
        assert_eq!(first.compression(), zip::CompressionMethod::Stored);
        drop(first);
        let mt = read_entry(&out, "mimetype");
        assert_eq!(mt, "application/epub+zip");
        // container → opf 경로.
        assert!(read_entry(&out, "META-INF/container.xml").contains("OEBPS/content.opf"));
        // opf: 제목(이스케이프)·수정 시각·스파인 순서.
        let opf = read_entry(&out, "OEBPS/content.opf");
        assert!(opf.contains("<dc:title>테스트 책</dc:title>"));
        assert!(opf.contains("dcterms:modified"));
        let i1 = opf.find("idref=\"ch1\"").unwrap();
        let i2 = opf.find("idref=\"ch2\"").unwrap();
        assert!(i1 < i2);
        // nav: 제목 이스케이프 확인.
        let nav = read_entry(&out, "OEBPS/nav.xhtml");
        assert!(nav.contains("둘째 장 &lt;태그&gt;"));
        // h2 중첩 목차.
        assert!(nav.contains("<a href=\"chapter1.xhtml#s1\">하위 절</a>"));
        // 챕터 문서: XHTML 선언·스타일 참조·본문.
        let ch1 = read_entry(&out, "OEBPS/chapter1.xhtml");
        assert!(ch1.contains("<!DOCTYPE html>"));
        assert!(ch1.contains("href=\"style.css\""));
        assert!(ch1.contains("<mark>강조</mark>"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn cover_image_wires_manifest_and_spine_first() {
        // 1x1 PNG.
        let png: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 0x0A, 0x49,
            0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0D, 0x0A, 0x2D, 0xB4, 0,
            0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let img = std::env::temp_dir().join(format!("md-export-cover-{}.png", std::process::id()));
        std::fs::write(&img, &png).unwrap();
        let mut o = opts();
        o.cover_path = Some(img.to_string_lossy().into_owned());
        let out = tmp("cover");
        export_epub(&o, &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        // 표지 이미지 엔트리 + cover.xhtml 존재.
        assert!(zip.by_name("OEBPS/cover-image").is_ok());
        assert!(zip.by_name("OEBPS/cover.xhtml").is_ok());
        let opf = read_entry(&out, "OEBPS/content.opf");
        assert!(opf.contains(r#"properties="cover-image""#));
        // 스파인에서 표지가 첫 항목.
        let cpos = opf.find("idref=\"coverpage\"").unwrap();
        let c1 = opf.find("idref=\"ch1\"").unwrap();
        assert!(cpos < c1);
        // nav 첫 항목이 표지.
        let nav = read_entry(&out, "OEBPS/nav.xhtml");
        let nav_cover = nav.find("cover.xhtml").unwrap();
        let nav_ch1 = nav.find("chapter1.xhtml").unwrap();
        assert!(nav_cover < nav_ch1);
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&img);
    }

    #[test]
    fn empty_chapters_rejected() {
        let mut o = opts();
        o.chapters.clear();
        assert!(export_epub(&o, &tmp("empty")).is_err());
    }

    #[test]
    fn body_images_embedded_deduped_and_manifested() {
        // 1x1 PNG 두 종 — 서로 다른 바이트.
        let png: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 0x0A, 0x49,
            0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0D, 0x0A, 0x2D, 0xB4, 0,
            0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let jpg = b"\xFF\xD8\xFF\xE0 fake jpg".to_vec();
        let dir = std::env::temp_dir().join(format!("md-export-epub-img-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("assets/pic.png"), &png).unwrap();
        std::fs::write(dir.join("assets/photo.jpg"), &jpg).unwrap();

        let mut o = opts();
        o.base_dir = dir.to_string_lossy().into_owned();
        // 같은 파일의 다른 표기 2회(중복 제거 확인) + 원격/데이터(그대로) + 없는 경로.
        o.chapters[0].body = "<p><img src=\"assets/pic.png\" alt=\"a\"/><img src=\"./assets/pic.png\" alt=\"b\"/></p>".into();
        o.chapters[1].body = "<p><img src=\"https://x/y.png\"/><img src=\"data:image/png;base64,AAAA\"/><img src=\"assets/photo.jpg\"/><img src=\"assets/none.png\"/></p>".into();
        let out = tmp("images");
        export_epub(&o, &out).unwrap();

        let bytes = std::fs::read(&out).unwrap();
        let cursor = std::io::Cursor::new(&bytes);
        let mut zip = zip::ZipArchive::new(cursor).unwrap();
        // 두 파일만 — pic.png는 ../ 경로와 함께 한 번으로.
        assert!(zip.by_name("OEBPS/images/img1.png").is_ok());
        assert!(zip.by_name("OEBPS/images/img2.jpg").is_ok());
        assert!(zip.by_name("OEBPS/images/img3.png").is_err());
        let ch1 = read_entry(&out, "OEBPS/chapter1.xhtml");
        assert!(ch1.contains("src=\"images/img1.png\""));
        assert_eq!(ch1.matches("images/img1.png").count(), 2);
        let ch2 = read_entry(&out, "OEBPS/chapter2.xhtml");
        // 원격·데이터 URI는 재작성 없음.
        assert!(ch2.contains("src=\"https://x/y.png\""));
        assert!(ch2.contains("src=\"data:image/png;base64,AAAA\""));
        assert!(ch2.contains("src=\"images/img2.jpg\""));
        // 읽기 실패 경로는 원본 유지.
        assert!(ch2.contains("src=\"assets/none.png\""));
        // 매니페스트 등록.
        let opf = read_entry(&out, "OEBPS/content.opf");
        assert!(opf.contains("<item id=\"img1\" href=\"images/img1.png\" media-type=\"image/png\"/>"));
        assert!(opf.contains("<item id=\"img2\" href=\"images/img2.jpg\" media-type=\"image/jpeg\"/>"));

        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn percent_decoding_and_scheme_detection() {
        assert_eq!(percent_decode("a%20b%2Fc%zz"), "a b/c%zz");
        assert_eq!(percent_decode("%EC%BD%94"), "코");
        assert!(has_scheme("http://x"));
        assert!(has_scheme("data:image/png;base64,x"));
        assert!(has_scheme("mailto:a@b"));
        assert!(!has_scheme("assets/pic.png"));
        assert!(!has_scheme("pic.png"));
        assert!(!has_scheme("#anchor"));
    }
}
