//! EPUB 3 내보내기 — 최소 유효 패키지(mimetype·container·OPF·nav·챕터·CSS).
//! 콘텐츠(XHTML 본문)는 호출자가 넘기고 여기서는 조립과 zip만
//! (DOCX와 같은 원칙: 바깥 쪽 변환은 프런트가, 포장은 Rust가).
//! 1단계(이 모듈): 단일/다중 챕터 + 목차. 이미지·표지·챕터 자동 분할은 다음 단계.

use std::io::Write;
use std::path::Path;

/// 챕터 하나 — file은 "chapter1.xhtml" 같은 OEBPS 상대 이름.
pub struct EpubChapter {
    pub title: String,
    /// 챕터 본문 XHTML(<body> 안쪽 — 이미 이스케이프/정규화된 것).
    pub body: String,
    pub file: String,
}

pub struct EpubOptions {
    pub title: String,
    pub author: String,
    /// "ko" / "en".
    pub language: String,
    pub chapters: Vec<EpubChapter>,
    pub css: String,
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

    // nav.xhtml — EPUB3 목차.
    let nav_items: String = opts
        .chapters
        .iter()
        .map(|c| format!("<li><a href=\"{}\">{}</a></li>", c.file, esc(&c.title)))
        .collect::<Vec<_>>()
        .join("\n");
    let nav = xhtml_doc(
        &opts.title,
        &opts.language,
        &format!("<nav epub:type=\"toc\" id=\"toc\"><h1>{}</h1><ol>\n{nav_items}\n</ol></nav>", esc(&opts.title)),
    );
    add(&mut zip, "OEBPS/nav.xhtml", &nav)?;

    // 챕터들.
    for c in &opts.chapters {
        add(&mut zip, &format!("OEBPS/{}", c.file), &xhtml_doc(&c.title, &opts.language, &c.body))?;
    }
    add(&mut zip, "OEBPS/style.css", &opts.css)?;

    // content.opf — 메타데이터·매니페스트·스파인.
    let mut manifest = String::from(
        "<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n<item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>",
    );
    let mut spine = String::new();
    for (i, c) in opts.chapters.iter().enumerate() {
        manifest.push_str(&format!(
            "\n<item id=\"ch{}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>",
            i + 1,
            c.file
        ));
        spine.push_str(&format!("\n<itemref idref=\"ch{}\"/>", i + 1));
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
            chapters: vec![
                EpubChapter {
                    title: "첫 장".into(),
                    body: "<h1>첫 장</h1><p>내용 <mark>강조</mark></p>".into(),
                    file: "chapter1.xhtml".into(),
                },
                EpubChapter {
                    title: "둘째 장 <태그>".into(),
                    body: "<p>둘째</p>".into(),
                    file: "chapter2.xhtml".into(),
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
        // 챕터 문서: XHTML 선언·스타일 참조·본문.
        let ch1 = read_entry(&out, "OEBPS/chapter1.xhtml");
        assert!(ch1.contains("<!DOCTYPE html>"));
        assert!(ch1.contains("href=\"style.css\""));
        assert!(ch1.contains("<mark>강조</mark>"));
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn empty_chapters_rejected() {
        let mut o = opts();
        o.chapters.clear();
        assert!(export_epub(&o, &tmp("empty")).is_err());
    }
}
