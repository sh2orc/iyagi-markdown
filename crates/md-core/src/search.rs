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
