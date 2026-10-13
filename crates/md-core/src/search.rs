//! 워크스페이스 전체 텍스트 검색 — 트리 스캔과 같은 규칙(마크다운만,
//! 숨김·무시 디렉터리 제외, 깊이 제한, 심볼릭 링크 무시)으로 파일을 모아
//! 대소문자무시 부분문자열 검색. 결과는 도달 순(폴더 먼저·이름순)이라
//! 같은 파일의 매치가 항상 연속한다. 표시용 줄 조각만 돌려준다.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::tree::{is_markdown_name, should_skip_dir_name};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    /// 1부터 시작하는 줄 번호.
    pub line_no: u32,
    /// 매치 줄의 표시용 조각(앞뒤 공백 제거, 길면 매치 중심으로 자른다).
    pub line: String,
}

/// 표시용 줄 최대 글자 수.
const CLIP_CHARS: usize = 200;

pub fn search_tree(root: &Path, needle: &str, max_hits: usize) -> std::io::Result<Vec<SearchHit>> {
    let mut hits = Vec::new();
    let needle = needle.trim();
    if needle.is_empty() || max_hits == 0 {
        return Ok(hits);
    }
    let mut files = Vec::new();
    collect_files(root, 0, 12, &mut files);
    let needle_l = needle.to_lowercase();
    for path in files {
        if hits.len() >= max_hits {
            break;
        }
        // 깨진 인코딩 파일도 서브스트링 검색은 가능해야 한다 — 손실 디코딩.
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue, // 권한·사라진 파일은 조용히 건너뛴다
        };
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if hits.len() >= max_hits {
                break;
            }
            if let Some(at) = line.to_lowercase().find(&needle_l) {
                hits.push(SearchHit {
                    path: path.to_string_lossy().into_owned(),
                    line_no: i as u32 + 1,
                    line: clip_line(line, at),
                });
            }
        }
    }
    Ok(hits)
}

/// 도달 순서가 사이드바 트리와 같은 파일 목록 수집(폴더 먼저·대소문자무시 이름순).
fn collect_files(dir: &Path, depth: u32, max_depth: u32, out: &mut Vec<PathBuf>) {
    if depth > max_depth {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // 권한·NotFound — 조용히
    };
    let mut dirs: Vec<(String, PathBuf)> = Vec::new();
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if !should_skip_dir_name(&name) {
                dirs.push((name, entry.path()));
            }
        } else if ft.is_file() && is_markdown_name(&name) {
            files.push((name, entry.path()));
        }
        // 심볼릭 링크는 양쪽 분기에 걸리지 않는다 — 건너뛴다(순환 방지).
    }
    let by_name = |a: &(String, PathBuf), b: &(String, PathBuf)| {
        a.0.to_lowercase()
            .cmp(&b.0.to_lowercase())
            .then_with(|| a.0.cmp(&b.0))
    };
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    for (_, p) in dirs {
        collect_files(&p, depth + 1, max_depth, out);
    }
    for (_, p) in files {
        out.push(p);
    }
}

/// 문서를 [[이름]]으로 참조하는 백링크를 찾는다(문서 자신 제외).
/// 이름 비교는 대소문자무시 — stem 일치 또는 루트 기준 상대 경로(확장자 없음)가
/// 대상을 접미로 포함([[folder/note]] → notes/의 note.md). 프런트 해석 규칙
/// (editor/wiki.ts resolveWikiLink)과 같은 방향의 관대함.
pub fn find_backlinks(root: &Path, doc_path: &str, max: usize) -> std::io::Result<Vec<SearchHit>> {
    let mut out = Vec::new();
    if max == 0 {
        return Ok(out);
    }
    let doc_file = Path::new(doc_path);
    let file_name = doc_file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = match file_name.rfind('.') {
        Some(i) => file_name[..i].to_lowercase(),
        None => file_name.to_lowercase(),
    };
    if stem.is_empty() {
        return Ok(out);
    }
    // 루트 기준 상대 경로(확장자 제거·소문자) — 경로 포함 참조 비교용.
    let root_s = root.to_string_lossy();
    let rel_stem = doc_path
        .strip_prefix(root_s.as_ref())
        .unwrap_or(doc_path)
        .trim_start_matches('/')
        .to_lowercase();
    let rel_stem = match rel_stem.rfind('.') {
        Some(i) => rel_stem[..i].to_string(),
        None => rel_stem,
    };
    let mut files = Vec::new();
    collect_files(root, 0, 12, &mut files);
    for path in files {
        if out.len() >= max {
            break;
        }
        if path.as_os_str().to_string_lossy() == doc_path {
            continue; // 문서 자신
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if out.len() >= max {
                break;
            }
            // 줄 안의 모든 [[..]] 검사 — 대상은 | 또는 # 앞까지.
            let mut from = 0;
            while let Some(open) = line[from..].find("[[") {
                let abs_open = from + open;
                let rest = &line[abs_open + 2..];
                let close = rest.find("]]").map(|c| abs_open + 2 + c);
                let nl = rest.find('\n').map(|c| abs_open + 2 + c);
                let end = match (close, nl) {
                    (Some(c), Some(n)) => c.min(n),
                    (Some(c), None) => c,
                    (None, _) => break,
                };
                let body = &line[abs_open + 2..end];
                let target = body
                    .split(['|', '#'])
                    .next()
                    .unwrap_or("")
                    .trim()
                    .replace('\\', "/")
                    .to_lowercase();
                if !target.is_empty()
                    && (target == stem || (target.contains('/') && rel_stem.ends_with(&target)))
                {
                    out.push(SearchHit {
                        path: path.to_string_lossy().into_owned(),
                        line_no: i as u32 + 1,
                        line: clip_line(line, abs_open),
                    });
                }
                from = end.max(abs_open + 2);
            }
        }
    }
    Ok(out)
}

fn char_floor(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn char_offset(s: &str, n: usize) -> usize {
    s.char_indices().nth(n).map(|(i, _)| i).unwrap_or(s.len())
}

/// 긴 줄은 매치 중심으로 CLIP_CHARS 글자 창을 내고 양끝에 말줄임표.
fn clip_line(line: &str, at: usize) -> String {
    let trimmed = line.trim();
    let total = trimmed.chars().count();
    if total <= CLIP_CHARS {
        return trimmed.to_string();
    }
    let lead = line.len() - line.trim_start().len();
    let rel = char_floor(trimmed, at.saturating_sub(lead).min(trimmed.len()));
    let rel_chars = trimmed[..rel].chars().count();
    let start_char = rel_chars.saturating_sub(60);
    let end_char = (start_char + CLIP_CHARS).min(total);
    let start = char_offset(trimmed, start_char);
    let end = char_offset(trimmed, end_char);
    let mut out = String::new();
    if start_char > 0 {
        out.push('…');
    }
    out.push_str(&trimmed[start..end]);
    if end_char < total {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("md-core-search-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn finds_case_insensitive_in_walk_order() {
        let d = tempdir("basic");
        fs::write(d.join("a.md"), "hello\nWorld MARKER here\n").unwrap();
        fs::create_dir_all(d.join("sub")).unwrap();
        fs::write(d.join("sub/b.md"), "no match\nmarker line\nanother marker\n").unwrap();
        fs::write(d.join("c.txt"), "marker — not markdown\n").unwrap();
        let hits = search_tree(&d, "Marker", 100).unwrap();
        let summary: Vec<(&str, u32)> = hits.iter().map(|h| (h.path.as_str(), h.line_no)).collect();
        // sub/가 폴더라 먼저 — b.md 2·3줄, 이어서 a.md 2줄.
        assert_eq!(
            summary,
            vec![(d.join("sub/b.md").to_str().unwrap(), 2), (d.join("sub/b.md").to_str().unwrap(), 3), (d.join("a.md").to_str().unwrap(), 2)]
        );
        assert_eq!(hits[0].line, "marker line");
        assert_eq!(hits[2].line, "World MARKER here");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn skips_ignored_dirs_and_respects_cap() {
        let d = tempdir("skip");
        fs::create_dir_all(d.join("node_modules/pkg")).unwrap();
        fs::write(d.join("node_modules/pkg/x.md"), "needle\n").unwrap();
        fs::create_dir_all(d.join(".h")).unwrap();
        fs::write(d.join(".h/hidden.md"), "needle\n").unwrap();
        for i in 0..5 {
            fs::write(d.join(format!("f{i}.md")), "needle\n").unwrap();
        }
        let hits = search_tree(&d, "needle", 3).unwrap();
        assert_eq!(hits.len(), 3);
        assert!(hits.iter().all(|h| !h.path.contains("node_modules") && !h.path.contains("/.h/")));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn backlinks_find_refs_excluding_self() {
        let d = tempdir("bl");
        fs::write(d.join("target.md"), "대상 문서\n").unwrap();
        fs::write(
            d.join("a.md"),
            "이전에 [[target]]를 봤다.\n[[target|표시]]도 있다.\n[[other]]는 아님.\n[[folder/target]] 경로 참조.\n",
        )
        .unwrap();
        fs::write(d.join("self.md"), "[[target]] 자기 참조 아님 — 다른 문서.\n").unwrap();
        let hits = find_backlinks(&d, d.join("target.md").to_str().unwrap(), 100).unwrap();
        // [[folder/target]]은 루트의 target.md가 아닌 folder/target.md를 가리킨다 —
        // 백링크 아닌 것이 올바른 해석(에디터 resolveWikiLink와 같은 규칙).
        let from_a: Vec<u32> = hits
            .iter()
            .filter(|h| h.path.ends_with("a.md"))
            .map(|h| h.line_no)
            .collect();
        assert_eq!(from_a, vec![1, 2]);
        // self.md는 이름과 달리 다른 문서 — [[target]] 참조는 백링크다.
        assert_eq!(hits.iter().filter(|h| h.path.ends_with("self.md")).count(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn backlinks_exclude_self_and_empty_stem() {
        let d = tempdir("blself");
        fs::write(d.join("me.md"), "[[me]] 자기 자신.\n").unwrap();
        let me = d.join("me.md").to_str().unwrap().to_string();
        assert!(find_backlinks(&d, &me, 100).unwrap().is_empty());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_needle_is_empty_and_long_lines_clip() {
        let d = tempdir("clip");
        assert!(search_tree(&d, "  ", 10).unwrap().is_empty());
        let long = format!("{}needle{}", "가".repeat(500), "나".repeat(500));
        fs::write(d.join("long.md"), format!("{long}\n")).unwrap();
        let hits = search_tree(&d, "needle", 10).unwrap();
        assert_eq!(hits.len(), 1);
        let l = &hits[0].line;
        assert!(l.starts_with('…') && l.ends_with('…'));
        assert!(l.chars().count() <= CLIP_CHARS + 2);
        assert!(l.contains("needle"));
        let _ = fs::remove_dir_all(&d);
    }
}

/// 작업 폴더 전체 찾아바꾸기 결과 — 파일별 교체 수.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub path: String,
    pub count: usize,
}

/// 루트 아래 모든 .md에서 needle → replacement(대소문자 구분 없음 옵션).
/// 각 파일은 md_core::io::write_doc_atomic 경로로 **원자적 저장**된다 —
/// 문서 메타(BOM/CRLF)는 그대로 보존되고, 실패한 파일은 건너뛰고 계속한다.
pub fn replace_all_tree(
    root: &Path,
    needle: &str,
    replacement: &str,
    case_sensitive: bool,
) -> std::io::Result<Vec<ReplaceOutcome>> {
    let mut out = Vec::new();
    if needle.is_empty() {
        return Ok(out);
    }
    let mut files = Vec::new();
    collect_files(root, 0, 12, &mut files);
    for path in files {
        let Ok(original) = std::fs::read(&path) else { continue };
        let Ok(doc) = crate::io::decode_doc(original, &path) else { continue };
        let (hay, matched): (String, bool) = if case_sensitive {
            (doc.text.clone(), doc.text.contains(needle))
        } else {
            // 대소문자 무시 교체 — 소문자 비교 후 원본 슬라이스 재조립.
            (doc.text.clone(), doc.text.to_lowercase().contains(&needle.to_lowercase()))
        };
        if !matched {
            continue;
        }
        let replaced = if case_sensitive {
            doc.text.replace(needle, replacement)
        } else {
            case_insensitive_replace(&doc.text, needle, replacement)
        };
        if replaced != doc.text {
            crate::io::write_doc_atomic(&path, &replaced, doc.meta).map_err(std::io::Error::other)?;
            let count = count_replacements(&hay, needle, case_sensitive);
            out.push(ReplaceOutcome { path: path.to_string_lossy().into_owned(), count });
        }
    }
    Ok(out)
}

fn case_insensitive_replace(hay: &str, needle: &str, replacement: &str) -> String {
    let hay_l = hay.to_lowercase();
    let needle_l = needle.to_lowercase();
    let mut out = String::with_capacity(hay.len());
    let mut prev = 0usize;
    while let Some(idx) = hay_l[prev..].find(&needle_l) {
        let at = prev + idx;
        out.push_str(&hay[prev..at]);
        out.push_str(replacement);
        prev = at + needle.chars().count().max(1);
    }
    out.push_str(&hay[prev.min(hay.len())..]);
    out
}

fn count_replacements(hay: &str, needle: &str, case_sensitive: bool) -> usize {
    if case_sensitive {
        hay.matches(needle).count()
    } else {
        let hay_l = hay.to_lowercase();
        let needle_l = needle.to_lowercase();
        let mut n = 0;
        let mut at = 0usize;
        while let Some(idx) = hay_l[at..].find(&needle_l) {
            n += 1;
            at += idx + needle_l.len();
        }
        n
    }
}

#[cfg(test)]
mod replace_tests {
    use super::*;
    use std::fs;

    fn tempdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("md-core-repl-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn replaces_across_files_atomically() {
        let d = tempdir("basic");
        fs::write(d.join("a.md"), "foo 와 bar\n").unwrap();
        fs::write(d.join("b.md"), "없음\n").unwrap();
        fs::write(d.join("c.MARKDOWN"), "foo foo\n").unwrap();
        let out = replace_all_tree(&d, "foo", "BAZ", true).unwrap();
        assert_eq!(out.len(), 2); // b.md는 매치 없음
        assert_eq!(fs::read_to_string(d.join("a.md")).unwrap(), "BAZ 와 bar\n");
        assert_eq!(fs::read_to_string(d.join("c.MARKDOWN")).unwrap(), "BAZ BAZ\n");
        assert_eq!(out[0].count, 1);
        assert_eq!(out[1].count, 2);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn case_insensitive_preserves_surroundings() {
        let d = tempdir("case");
        fs::write(d.join("a.md"), "Hello hello HELLO\n").unwrap();
        replace_all_tree(&d, "hello", "안녕", false).unwrap();
        assert_eq!(fs::read_to_string(d.join("a.md")).unwrap(), "안녕 안녕 안녕\n");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn crlf_and_bom_survive_replace() {
        let d = tempdir("meta");
        fs::write(d.join("a.md"), b"\xEF\xBB\xBFfoo\r\nbar\r\n").unwrap();
        replace_all_tree(&d, "foo", "x", true).unwrap();
        assert_eq!(fs::read(d.join("a.md")).unwrap(), b"\xEF\xBB\xBFx\r\nbar\r\n");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn update_wiki_links_propagates() {
        let dir = std::env::temp_dir().join(format!("md-core-wiki-upd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "링크 [[b]] 와 [[b|표시]] 와 [[b#앵커]] 와 [[c]]\n").unwrap();
        std::fs::write(dir.join("b.md"), "자기 참조 아님, [[a]]는 유지\n").unwrap();
        std::fs::write(dir.join("fence.md"), "```\n[[b]]\n```\n[[b]]\n").unwrap();
        let n = update_wiki_links(&dir, "b", "새이름").unwrap();
        assert_eq!(n, 4);
        let a = std::fs::read_to_string(dir.join("a.md")).unwrap();
        assert!(a.contains("[[새이름]]"));
        assert!(a.contains("[[새이름|표시]]"));
        assert!(a.contains("[[새이름#앵커]]"));
        assert!(a.contains("[[c]]"));
        let b = std::fs::read_to_string(dir.join("b.md")).unwrap();
        assert!(b.contains("[[a]]"));
        let f = std::fs::read_to_string(dir.join("fence.md")).unwrap();
        assert!(f.lines().nth(1).unwrap().contains("[[b]]"));
        assert!(f.lines().nth(3).unwrap().contains("[[새이름]]"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 고아 자원(이미지) 정보.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanAsset {
    /// 절대 경로.
    pub path: String,
    /// 크기(바이트).
    pub size: u64,
}

/// 워크스페이스 루트의 assets/ 하위에서 .md 파일이 참조하지 않는 이미지 찾기.
/// 참조 판정: 모든 .md 내용에서 파일명(또는 상대경로)이 나타나면 참조 중.
pub fn find_orphan_assets(root: &Path) -> std::io::Result<Vec<OrphanAsset>> {
    // 1. 모든 .md 파일의 내용을 합친다(큰 워크스페이스에서도 문자열 포함 검색이라 충분).
    let mut all_text = String::new();
    let mut files = Vec::new();
    collect_files(root, 0, 12, &mut files);
    for path in &files {
        if let Ok(content) = fs::read_to_string(path) {
            all_text.push_str(&content);
            all_text.push('\n');
        }
    }
    // 2. assets/ 하위의 이미지 파일을 나열.
    let assets_dir = root.join("assets");
    if !assets_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut orphans = Vec::new();
    let mut asset_files = Vec::new();
    collect_files(&assets_dir, 0, 6, &mut asset_files);
    for path in asset_files {
        // 이미지 확장자만.
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp") {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        // 참조 여부: 파일명이 어떤 .md에 나타나는가(경로 전체가 아닌 이름으로 —
        // `![](assets/foo.png)`든 `![[foo.png]]`든 잡히게).
        if all_text.contains(&name) {
            continue;
        }
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        orphans.push(OrphanAsset {
            path: path.to_string_lossy().into_owned(),
            size,
        });
    }
    // 큰 것부터.
    orphans.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(orphans)
}

/// 위키링크 간선 — 출발 문서 → 대상 키.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiEdge {
    pub from: String,
    pub to: String,
}

/// 워크스페이스의 모든 .md에서 [[링크]]를 추출해 간선 목록으로.
/// 대상 해석은 프런트가 wiki 인덱스로 수행(이름→경로).
pub fn extract_wiki_edges(root: &Path) -> std::io::Result<Vec<WikiEdge>> {
    let mut files = Vec::new();
    collect_files(root, 0, 12, &mut files);
    let mut edges = Vec::new();
    for path in files {
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let from = path.to_string_lossy().into_owned();
        for line in content.lines() {
            let t = line.trim_start();
            if t.starts_with("```") || t.starts_with("~~~") {
                continue; // 대략적 펜스 스킵(정확한 추적은 과함).
            }
            for m in content_wiki_links(line) {
                edges.push(WikiEdge {
                    from: from.clone(),
                    to: m,
                });
            }
        }
    }
    Ok(edges)
}

/// 한 줄에서 [[키]] 패턴 추출 — 중첩 괄호 안은 건너뛴다(대상 키만).
fn content_wiki_links(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(close) = find_wiki_close(line, i + 2) {
                let inner = &line[i + 2..close];
                // |표시 분리(표시 텍스트 제거), #앵커 분리.
                let target = inner.split('|').next().unwrap_or(inner);
                let target = target.split('#').next().unwrap_or(target).trim();
                if !target.is_empty()
                    && !target.contains(char::is_whitespace)
                    && !target.contains(']')
                {
                    out.push(target.to_string());
                }
                i = close + 1;
            } else {
                i += 2;
            }
        } else {
            i += 1;
        }
    }
    out
}

fn find_wiki_close(line: &str, from: usize) -> Option<usize> {
    let bytes = line.as_bytes();
    let mut depth = 0;
    for i in from..bytes.len() {
        if bytes[i] == b'[' {
            depth += 1;
        } else if bytes[i] == b']' {
            if depth == 0 {
                if i + 1 < bytes.len() && bytes[i + 1] == b']' {
                    return Some(i);
                }
            } else {
                depth -= 1;
            }
        }
    }
    None
}

/// 이름 변경 전파 — 워크스페이스의 [[from]](·[[from|표시]]·[[from#앵커]])를
/// [[to]]로 고치고 원자적으로 저장(메타 보존). 갱신된 링크 수 반환.
/// 대상은 정확히 일치하는 스템만(본문의 우연한 같은 단어는 건드리지 않음).
pub fn update_wiki_links(root: &Path, from: &str, to: &str) -> std::io::Result<u32> {
    let mut files = Vec::new();
    collect_files(root, 0, 12, &mut files);
    let mut total = 0u32;
    for path in files {
        let doc = match crate::io::read_doc(&path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let (text, meta) = (doc.text, doc.meta);
        let mut out = String::with_capacity(text.len() + 64);
        let mut changed = 0u32;
        let mut in_fence = false;
        let mut fence = "";
        let mut first = true;
        for line in text.split('\n') {
            if !first {
                out.push('\n');
            }
            first = false;
            let t = line.trim_start();
            if let Some(c) = t.chars().next() {
                if (c == '`' || c == '~') && t.len() >= 3 && t.chars().all(|x| x == c) {
                    if !in_fence {
                        in_fence = true;
                        fence = &t[..3];
                    } else if &t[..3] == fence {
                        in_fence = false;
                    }
                }
            }
            if in_fence || t.starts_with("```") || t.starts_with("~~~") {
                out.push_str(line);
                continue;
            }
            out.push_str(&replace_line_wiki_links(line, from, to, &mut changed));
        }
        if changed > 0 {
            if let Err(e) = crate::io::write_doc_atomic(&path, &out, meta.clone()) {
                return Err(std::io::Error::other(e.to_string()));
            }
            total += changed;
        }
    }
    Ok(total)
}

/// 한 줄의 [[from…]] 대상만 to로 치환(표시·앵커는 보존).
fn replace_line_wiki_links(line: &str, from: &str, to: &str, changed: &mut u32) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(close) = find_wiki_close(line, i + 2) {
                let inner = &line[i + 2..close];
                let target = inner.split('|').next().unwrap_or(inner);
                let target = target.split('#').next().unwrap_or(target).trim();
                if target == from {
                    // 대상 부분만 교체 — 이후 |·# 그대로.
                    let after = &inner[target.len()..];
                    out.push_str("[[");
                    out.push_str(to);
                    out.push_str(after);
                    out.push_str("]]");
                    *changed += 1;
                    i = close + 2;
                    continue;
                }
            }
        }
        // 바이트 단위가 아니라 문자 단위로 전진(한글 등 멀티바이트 경계 보존).
        let ch = line[i..].chars().next().unwrap_or('\u{0}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out

}
