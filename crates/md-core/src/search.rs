//! 워크스페이스 전체 텍스트 검색 — 트리 스캔과 같은 규칙(마크다운만,
//! 숨김·무시 디렉터리 제외, 깊이 제한, 심볼릭 링크 무시)으로 파일을 모아
//! 대소문자무시 부분문자열 검색. 결과는 도달 순(폴더 먼저·이름순)이라
//! 같은 파일의 매치가 항상 연속한다. 표시용 줄 조각만 돌려준다.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::tree::{ScanIssue, TreeNode};

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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchReport {
    pub hits: Vec<SearchHit>,
    pub issues: Vec<ScanIssue>,
    /// True only after finding a matching line beyond the returned result limit.
    pub truncated: bool,
    pub files_read: usize,
    pub files_total: usize,
}

pub fn search_tree(root: &Path, needle: &str, max_hits: usize) -> std::io::Result<Vec<SearchHit>> {
    search_tree_with_case(root, needle, max_hits, false)
}

pub fn search_tree_with_case(
    root: &Path,
    needle: &str,
    max_hits: usize,
    case_sensitive: bool,
) -> std::io::Result<Vec<SearchHit>> {
    search_report(root, needle, max_hits, case_sensitive).map(|report| report.hits)
}

pub fn search_report(
    root: &Path,
    needle: &str,
    max_hits: usize,
    case_sensitive: bool,
) -> std::io::Result<SearchReport> {
    search_report_with_limits(
        root,
        needle,
        max_hits,
        case_sensitive,
        4 * 1024 * 1024,
        128 * 1024 * 1024,
    )
}

fn search_report_with_limits(
    root: &Path,
    needle: &str,
    max_hits: usize,
    case_sensitive: bool,
    max_file_bytes: usize,
    max_total_bytes: usize,
) -> std::io::Result<SearchReport> {
    use std::io::Read;
    let needle = needle.trim();
    if needle.is_empty() || max_hits == 0 {
        return Ok(SearchReport::default());
    }
    if needle.chars().count() > 1024 {
        return Err(std::io::Error::other(
            "Search term exceeds 1,024 characters.",
        ));
    }
    let (files, issues) = scan_search_files(root)?;
    let mut report = SearchReport {
        files_total: files.len(),
        issues,
        ..SearchReport::default()
    };
    let mut remaining = max_total_bytes;
    let matcher = LiteralMatcher::new(needle, case_sensitive);
    for path in files {
        if remaining == 0 {
            report.issues.push(ScanIssue {
                path: path.to_string_lossy().into_owned(),
                code: "budget".into(),
                message: "Search read limit reached; remaining documents were not searched.".into(),
            });
            break;
        }
        // Bound actual reads, including failures and oversized documents.
        let cap = max_file_bytes.saturating_add(1).min(remaining);
        let mut bytes = Vec::new();
        let read =
            fs::File::open(&path).and_then(|file| file.take(cap as u64).read_to_end(&mut bytes));
        remaining -= bytes.len();
        let failure = |code: &str, message: String| ScanIssue {
            path: path.to_string_lossy().into_owned(),
            code: code.into(),
            message,
        };
        if let Err(error) = read {
            report.issues.push(failure("read", error.to_string()));
            continue;
        }
        if bytes.len() > max_file_bytes {
            report.issues.push(failure(
                "size",
                "Document exceeds the search file-size limit.".into(),
            ));
            continue;
        }
        // A read exactly filling the remaining budget may have stopped before EOF.
        // Keep that document out of the results rather than claiming a complete read.
        if bytes.len() == cap && cap <= max_file_bytes {
            report.issues.push(failure(
                "budget",
                "Search read limit reached; this and remaining documents were not searched.".into(),
            ));
            break;
        }
        let doc = match crate::io::decode_doc(bytes, &path) {
            Ok(doc) => doc,
            Err(error) => {
                report.issues.push(failure("encoding", error.to_string()));
                continue;
            }
        };
        report.files_read += 1;
        for (i, line) in doc.text.lines().enumerate() {
            if let Some(&(at, _)) = matcher.ranges(line, 1).first() {
                if report.hits.len() == max_hits {
                    report.truncated = true;
                    return Ok(report);
                }
                report.hits.push(SearchHit {
                    path: path.to_string_lossy().into_owned(),
                    line_no: i as u32 + 1,
                    line: clip_line(line, at),
                });
            }
        }
    }
    Ok(report)
}

fn scan_search_files(root: &Path) -> std::io::Result<(Vec<PathBuf>, Vec<ScanIssue>)> {
    fn walk(nodes: Vec<TreeNode>, paths: &mut Vec<PathBuf>) {
        for node in nodes {
            match node {
                TreeNode::Dir { children, .. } => walk(children, paths),
                TreeNode::File { path, .. } => paths.push(PathBuf::from(path)),
            }
        }
    }
    let scan = crate::tree::scan_tree(root)?;
    let mut paths = Vec::new();
    walk(scan.tree, &mut paths);
    Ok((paths, scan.issues))
}

/// 위키·일반 Markdown 링크의 실제 대상 경로로 백링크를 찾는다.
pub fn find_backlinks(root: &Path, doc_path: &str, max: usize) -> std::io::Result<Vec<SearchHit>> {
    if max == 0 {
        return Ok(Vec::new());
    }
    let (tree, files) = crate::wiki_rename::inventory(root)?;
    let index = crate::wiki_rename::index(&tree);
    let inventory: HashSet<_> = files.iter().map(String::as_str).collect();
    if !inventory.contains(doc_path) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut remaining = 128 * 1024 * 1024;
    for path in &files {
        if out.len() >= max {
            break;
        }
        if path == doc_path {
            continue;
        }
        let content = read_link_document(Path::new(path), &mut remaining)?;
        let lines: Vec<_> = content.lines().collect();
        let dir = Path::new(path).parent().unwrap_or(root);
        for target in crate::document_links::targets(&content).map_err(std::io::Error::other)? {
            if out.len() >= max {
                break;
            }
            if resolve_document_link(&target.destination, &index, &inventory, dir) == Some(doc_path)
                && seen.insert((path.clone(), target.line))
            {
                let line = lines.get(target.line - 1).copied().unwrap_or("");
                let start = content[..target.start]
                    .rfind('\n')
                    .map(|i| i + 1)
                    .unwrap_or(0);
                out.push(SearchHit {
                    path: path.clone(),
                    line_no: target.line as u32,
                    line: clip_line(line, target.start.saturating_sub(start)),
                });
            }
        }
    }
    Ok(out)
}

fn resolve_document_link<'a>(
    destination: &crate::document_links::Destination,
    index: &'a crate::wiki_rename::Index,
    inventory: &HashSet<&'a str>,
    dir: &Path,
) -> Option<&'a str> {
    use crate::{document_links::Destination, links::LinkTarget};
    match destination {
        Destination::Wiki(name) => crate::wiki_rename::resolve(index, name, dir),
        Destination::Url(url) => match crate::links::resolve(url, dir) {
            LinkTarget::Markdown { path, .. } => inventory.get(path.to_str()?).copied(),
            _ => None,
        },
    }
}

fn read_link_document(path: &Path, remaining: &mut usize) -> std::io::Result<String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(std::io::Error::other(format!(
            "Link document exceeds 4 MiB: {}",
            path.display()
        )));
    }
    *remaining = remaining.checked_sub(bytes.len()).ok_or_else(|| {
        std::io::Error::other("Document connection scan exceeds 128 MiB. Open a smaller folder.")
    })?;
    crate::io::decode_doc(bytes, path)
        .map(|doc| doc.text)
        .map_err(std::io::Error::other)
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
        fs::write(
            d.join("sub/b.md"),
            "no match\nmarker line\nanother marker\n",
        )
        .unwrap();
        fs::write(d.join("c.txt"), "marker — not markdown\n").unwrap();
        let hits = search_tree(&d, "Marker", 100).unwrap();
        let summary: Vec<(&str, u32)> = hits.iter().map(|h| (h.path.as_str(), h.line_no)).collect();
        // sub/가 폴더라 먼저 — b.md 2·3줄, 이어서 a.md 2줄.
        assert_eq!(
            summary,
            vec![
                (d.join("sub/b.md").to_str().unwrap(), 2),
                (d.join("sub/b.md").to_str().unwrap(), 3),
                (d.join("a.md").to_str().unwrap(), 2)
            ]
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
        assert!(hits
            .iter()
            .all(|h| !h.path.contains("node_modules") && !h.path.contains("/.h/")));
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
        fs::write(
            d.join("self.md"),
            "[[target]] 자기 참조 아님 — 다른 문서.\n",
        )
        .unwrap();
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
        assert_eq!(
            hits.iter().filter(|h| h.path.ends_with("self.md")).count(),
            1
        );
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
    fn backlinks_and_graph_share_resolved_markdown_and_wiki_targets() {
        let d = tempdir("document-links");
        fs::create_dir_all(d.join("a")).unwrap();
        fs::create_dir_all(d.join("b")).unwrap();
        fs::write(d.join("a/note.md"), "[self](note.md) [[note]]").unwrap();
        fs::write(d.join("b/note.md"), "other document").unwrap();
        fs::write(
            d.join("b/ref.md"),
            "[local](note.md) [[note]]\n\
            [cross](../a/note.md#heading) [[a/note]]\n\
            [reference][id]\n\n[id]: ../a/note.md \"title\"\n[unused]: ../a/note.md\n",
        )
        .unwrap();
        let target = d.join("a/note.md");
        let hits = find_backlinks(&d, target.to_str().unwrap(), 100).unwrap();
        assert_eq!(
            hits.iter().map(|hit| hit.line_no).collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert!(hits.iter().all(|hit| hit.path.ends_with("b/ref.md")));
        assert!(hits[1].line.contains("[reference][id]"));
        let edges = extract_document_edges(&d).unwrap();
        let destinations: Vec<_> = edges.iter().map(|edge| edge.to.as_str()).collect();
        assert_eq!(
            destinations,
            vec![
                d.join("b/note.md").to_str().unwrap(),
                target.to_str().unwrap()
            ]
        );
        assert!(edges.iter().all(|edge| edge.from.ends_with("b/ref.md")));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn link_uses_exclude_code_metadata_and_unused_definitions() {
        let d = tempdir("document-links-exclusions");
        fs::write(d.join("target.md"), "target").unwrap();
        fs::write(
            d.join("ref.md"),
            "---\nlink: '[meta](target.md)'\n---\n\
            `[code](target.md)`\n\n```md\n[[target]] [code](target.md)\n```\n\n\
            <!-- [html](target.md) -->\n\n$[math](target.md)$\n\n\
            [unused]: target.md\n\n[actual](target.md)\n",
        )
        .unwrap();
        let hits = find_backlinks(&d, d.join("target.md").to_str().unwrap(), 100).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, "[actual](target.md)");
        assert_eq!(extract_document_edges(&d).unwrap().len(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn encoded_links_follow_real_files_and_reference_duplicate_precedence() {
        let d = tempdir("document-links-encoded");
        fs::write(d.join("한글 name.md"), "target").unwrap();
        fs::write(d.join("other.md"), "other").unwrap();
        fs::write(
            d.join("ref.md"),
            "[한글](%ED%95%9C%EA%B8%80%20name.md#개요)\n\
            ![document](<한글 name.md>)\n[duplicate][ID]\n\n\
            [id]: other.md\n[ID]: <한글 name.md>\n",
        )
        .unwrap();
        let hits = find_backlinks(&d, d.join("한글 name.md").to_str().unwrap(), 100).unwrap();
        assert_eq!(
            hits.iter().map(|hit| hit.line_no).collect::<Vec<_>>(),
            vec![1, 2]
        );
        let edges = extract_document_edges(&d).unwrap();
        assert_eq!(edges.len(), 2);
        assert!(edges[0].to.ends_with("한글 name.md"));
        assert!(edges[1].to.ends_with("other.md"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn unresolved_external_and_outside_workspace_targets_are_not_graph_nodes() {
        let d = tempdir("document-links-outside");
        fs::write(
            d.join("ref.md"),
            "[missing](missing.md) [[missing]] [outside](../target.md)\n\
            [web](https://host/target.md) [mail](mailto:a@host) [anchor](#heading)\n\
            [asset](image.png) [file](file:///tmp/target.md)\n",
        )
        .unwrap();
        assert!(extract_document_edges(&d).unwrap().is_empty());
        assert!(
            find_backlinks(&d, d.join("missing.md").to_str().unwrap(), 100)
                .unwrap()
                .is_empty()
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn unreadable_document_is_an_error_not_an_empty_connection_result() {
        let d = tempdir("document-links-failure");
        fs::write(d.join("target.md"), "target").unwrap();
        fs::write(d.join("bad.md"), [0xff]).unwrap();
        assert!(find_backlinks(&d, d.join("target.md").to_str().unwrap(), 100).is_err());
        assert!(extract_document_edges(&d).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn connection_read_budget_is_consumed_before_parsing_more_documents() {
        let d = tempdir("document-links-budget");
        let path = d.join("ref.md");
        fs::write(&path, "1234").unwrap();
        let mut remaining = 6;
        assert_eq!(read_link_document(&path, &mut remaining).unwrap(), "1234");
        assert_eq!(remaining, 2);
        assert!(read_link_document(&path, &mut remaining)
            .unwrap_err()
            .to_string()
            .contains("128 MiB"));
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

    #[test]
    fn search_reports_partial_reads_and_uses_editor_line_numbers() {
        let d = tempdir("search-report-partial");
        fs::write(d.join("a.md"), b"\xef\xbb\xbfhit\rhit\r\n").unwrap();
        fs::write(d.join("b.md"), [0xff]).unwrap();
        fs::write(d.join("c.markdown"), "x".repeat(17)).unwrap();
        let report = search_report_with_limits(&d, "hit", 10, false, 16, 100).unwrap();
        assert_eq!(
            report
                .hits
                .iter()
                .map(|hit| hit.line_no)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert!(report.hits.iter().all(|hit| hit.line == "hit"));
        assert_eq!(report.files_read, 1);
        assert_eq!(report.files_total, 3);
        assert_eq!(
            report
                .issues
                .iter()
                .map(|issue| issue.code.as_str())
                .collect::<Vec<_>>(),
            vec!["encoding", "size"]
        );
        assert!(!report.truncated);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn search_distinguishes_exact_result_cap_from_actual_truncation() {
        let d = tempdir("search-report-cap");
        fs::write(d.join("a.md"), "hit\nhit\n").unwrap();
        let exact = search_report(&d, "hit", 2, false).unwrap();
        assert_eq!(exact.hits.len(), 2);
        assert!(!exact.truncated);
        fs::write(d.join("b.md"), "hit").unwrap();
        let extra = search_report(&d, "hit", 2, false).unwrap();
        assert_eq!(extra.hits.len(), 2);
        assert!(extra.truncated);
        assert!(extra.issues.is_empty());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn search_budget_does_not_return_partial_file_matches_as_complete() {
        let d = tempdir("search-report-budget");
        fs::write(d.join("a.md"), "hit").unwrap();
        fs::write(d.join("b.md"), "hit later").unwrap();
        let report = search_report_with_limits(&d, "hit", 10, false, 16, 7).unwrap();
        assert_eq!(report.hits.len(), 1);
        assert_eq!(report.files_read, 1);
        assert_eq!(report.files_total, 2);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].code, "budget");
        assert!(!report.truncated);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn search_and_replace_share_hidden_file_and_depth_rules() {
        let d = tempdir("search-report-inventory");
        fs::write(d.join(".hidden.md"), "hit").unwrap();
        fs::write(d.join("__hidden.md"), "hit").unwrap();
        fs::write(d.join("visible.markdown"), "hit").unwrap();
        let mut nested = d.clone();
        for _ in 0..13 {
            nested = nested.join("nested");
        }
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("too-deep.md"), "hit").unwrap();
        let report = search_report(&d, "hit", 10, false).unwrap();
        assert_eq!(report.hits.len(), 1);
        assert!(report.hits[0].path.ends_with("visible.markdown"));
        assert!(report.issues.iter().any(|issue| issue.code == "depth"));
        let plan = prepare_replacement(&d, "hit", "changed", false).unwrap();
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].path, report.hits[0].path);
        assert_eq!(plan.skipped.len(), report.issues.len());
        assert_eq!(fs::read_to_string(d.join(".hidden.md")).unwrap(), "hit");
        assert!(search_report(&d.join("missing"), "hit", 10, false).is_err());
        assert!(search_report(&d, &"a".repeat(1025), 10, false).is_err());
        let _ = fs::remove_dir_all(d);
    }
}

/// 작업 폴더 전체 찾아바꾸기 결과 — 파일별 교체 수.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub path: String,
    pub count: usize,
}

/// A reviewed replacement holds the original text until apply; no files are written here.
pub struct ReplacementFile {
    pub path: String,
    pub before: String,
    pub after: String,
    pub meta: crate::io::DocMeta,
    pub count: usize,
}

pub struct ReplacementPlan {
    pub files: Vec<ReplacementFile>,
    pub skipped: Vec<ReplaceFailure>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplaceFailure {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct ReplaceReport {
    pub applied: Vec<ReplaceOutcome>,
    pub failed: Vec<ReplaceFailure>,
}

pub fn prepare_replacement(
    root: &Path,
    needle: &str,
    replacement: &str,
    case_sensitive: bool,
) -> std::io::Result<ReplacementPlan> {
    fs::read_dir(root)?; // Invalid/unreadable roots are errors, not an empty successful search.
    if needle.is_empty() {
        return Err(std::io::Error::other("Enter a search term"));
    }
    let (paths, issues) = scan_search_files(root)?;
    let mut plan = ReplacementPlan {
        files: Vec::new(),
        skipped: issues
            .into_iter()
            .map(|issue| ReplaceFailure {
                path: issue.path,
                message: issue.message,
            })
            .collect(),
    };
    let mut bytes = 0usize;
    for path in paths {
        let file = (|| -> Result<Option<ReplacementFile>, String> {
            use std::io::Read;
            let mut original = Vec::new();
            fs::File::open(&path)
                .map_err(|e| e.to_string())?
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut original)
                .map_err(|e| e.to_string())?;
            if original.len() > 4 * 1024 * 1024 {
                return Err("File exceeds the 4 MiB replacement limit".into());
            }
            let doc = crate::io::decode_doc(original, &path).map_err(|e| e.to_string())?;
            let (after, count) = replace_literal(&doc.text, needle, replacement, case_sensitive)
                .map_err(|e| e.to_string())?;
            if after == doc.text {
                return Ok(None);
            }
            Ok(Some(ReplacementFile {
                path: path.to_string_lossy().into_owned(),
                before: doc.text,
                after,
                meta: doc.meta,
                count,
            }))
        })();
        match file {
            Ok(Some(file)) => {
                bytes = bytes
                    .saturating_add(file.before.len())
                    .saturating_add(file.after.len());
                if bytes > 16 * 1024 * 1024 || plan.files.len() >= 500 {
                    return Err(std::io::Error::other("Replacement preview is too large. Choose a smaller folder or a more specific search term."));
                }
                plan.files.push(file);
            }
            Ok(None) => {}
            Err(message) => plan.skipped.push(ReplaceFailure {
                path: path.to_string_lossy().into_owned(),
                message,
            }),
        }
    }
    Ok(plan)
}

pub fn apply_replacement(
    plan: ReplacementPlan,
    mut before_write: impl FnMut(&ReplacementFile) -> std::io::Result<()>,
) -> ReplaceReport {
    let mut report = ReplaceReport {
        applied: Vec::new(),
        failed: plan.skipped,
    };
    for file in plan.files {
        let result = before_write(&file).and_then(|()| {
            crate::io::write_doc_checked(
                Path::new(&file.path),
                &file.after,
                file.meta,
                &crate::io::WriteExpectation::Match {
                    text: file.before.clone(),
                    meta: file.meta,
                },
            )
            .map_err(std::io::Error::other)
        });
        match result {
            Ok(()) => report.applied.push(ReplaceOutcome {
                path: file.path,
                count: file.count,
            }),
            Err(error) => report.failed.push(ReplaceFailure {
                path: file.path,
                message: error.to_string(),
            }),
        }
    }
    report
}

/// Matching, counts and replacement use the same original UTF-8 boundaries.
fn literal_ranges(hay: &str, needle: &str, case_sensitive: bool) -> Vec<(usize, usize)> {
    literal_ranges_limited(hay, needle, case_sensitive, usize::MAX)
}

fn literal_ranges_limited(
    hay: &str,
    needle: &str,
    case_sensitive: bool,
    limit: usize,
) -> Vec<(usize, usize)> {
    LiteralMatcher::new(needle, case_sensitive).ranges(hay, limit)
}

struct LiteralMatcher<'a> {
    needle: &'a str,
    case_sensitive: bool,
    query: Vec<char>,
    prefix: Vec<usize>,
}

fn same_lowercase(a: char, b: char) -> bool {
    a.to_lowercase().eq(b.to_lowercase())
}

impl<'a> LiteralMatcher<'a> {
    fn new(needle: &'a str, case_sensitive: bool) -> Self {
        // Build once per workspace search, not once per line. Matching keeps the
        // existing per-character lowercase equality and original UTF-8 offsets.
        let query: Vec<char> = if case_sensitive {
            Vec::new()
        } else {
            needle.chars().collect()
        };
        let mut prefix = vec![0usize; query.len()];
        for i in 1..query.len() {
            let mut matched = prefix[i - 1];
            while matched > 0 && !same_lowercase(query[i], query[matched]) {
                matched = prefix[matched - 1];
            }
            if same_lowercase(query[i], query[matched]) {
                matched += 1;
            }
            prefix[i] = matched;
        }
        Self {
            needle,
            case_sensitive,
            query,
            prefix,
        }
    }

    fn ranges(&self, hay: &str, limit: usize) -> Vec<(usize, usize)> {
        if self.needle.is_empty() || limit == 0 {
            return Vec::new();
        }
        if self.case_sensitive {
            return hay
                .match_indices(self.needle)
                .take(limit)
                .map(|(at, value)| (at, at + value.len()))
                .collect();
        }
        if hay.len() < self.query.len() {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut starts = std::collections::VecDeque::with_capacity(self.query.len());
        let mut matched = 0;
        for (at, ch) in hay.char_indices() {
            starts.push_back(at);
            if starts.len() > self.query.len() {
                starts.pop_front();
            }
            while matched > 0 && !same_lowercase(ch, self.query[matched]) {
                matched = self.prefix[matched - 1];
            }
            if same_lowercase(ch, self.query[matched]) {
                matched += 1;
            }
            if matched == self.query.len() {
                out.push((*starts.front().unwrap(), at + ch.len_utf8()));
                if out.len() >= limit {
                    break;
                }
                matched = 0; // Keep non-overlapping replacement/highlight semantics.
                starts.clear();
            }
        }
        out
    }
}

fn replace_literal(
    hay: &str,
    needle: &str,
    replacement: &str,
    case_sensitive: bool,
) -> std::io::Result<(String, usize)> {
    let ranges = literal_ranges(hay, needle, case_sensitive);
    let removed: usize = ranges.iter().map(|(from, to)| to - from).sum();
    let output_size = hay
        .len()
        .saturating_sub(removed)
        .saturating_add(ranges.len().saturating_mul(replacement.len()));
    if output_size > 16 * 1024 * 1024 {
        return Err(std::io::Error::other("Replacement output exceeds 16 MiB"));
    }
    let mut out = String::with_capacity(hay.len());
    let mut start = 0;
    let mut changed = 0;
    for &(from, to) in &ranges {
        if &hay[from..to] != replacement {
            changed += 1;
        }
        out.push_str(&hay[start..from]);
        out.push_str(replacement);
        start = to;
    }
    out.push_str(&hay[start..]);
    Ok((out, changed))
}

#[cfg(test)]
fn case_insensitive_replace(hay: &str, needle: &str, replacement: &str) -> String {
    replace_literal(hay, needle, replacement, false).unwrap().0
}

#[cfg(test)]
fn replace_all_tree(
    root: &Path,
    needle: &str,
    replacement: &str,
    case_sensitive: bool,
) -> std::io::Result<Vec<ReplaceOutcome>> {
    let report = apply_replacement(
        prepare_replacement(root, needle, replacement, case_sensitive)?,
        |_| Ok(()),
    );
    if let Some(error) = report.failed.first() {
        return Err(std::io::Error::other(error.message.clone()));
    }
    Ok(report.applied)
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
    fn preview_counts_occurrences_without_writing_and_apply_reports_conflicts() {
        let dir = tempdir("reviewed");
        fs::write(dir.join("a.md"), "foo foo\n").unwrap();
        fs::write(dir.join("b.md"), "foo\n").unwrap();
        let plan = prepare_replacement(&dir, "foo", "bar", true).unwrap();
        assert_eq!(plan.files.iter().map(|file| file.count).sum::<usize>(), 3);
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "foo foo\n");
        fs::write(dir.join("b.md"), "edited after preview").unwrap();
        fs::write(dir.join("new.md"), "foo").unwrap();
        let report = apply_replacement(plan, |_| Ok(()));
        assert_eq!(report.applied.len(), 1);
        assert_eq!(report.applied[0].count, 2);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "bar bar\n");
        assert_eq!(
            fs::read_to_string(dir.join("b.md")).unwrap(),
            "edited after preview"
        );
        assert_eq!(fs::read_to_string(dir.join("new.md")).unwrap(), "foo");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn backup_failure_leaves_document_unchanged() {
        let dir = tempdir("backup-failure");
        fs::write(dir.join("a.md"), "foo").unwrap();
        let plan = prepare_replacement(&dir, "foo", "bar", true).unwrap();
        let report = apply_replacement(plan, |_| Err(std::io::Error::other("disk full")));
        assert!(report.applied.is_empty());
        assert_eq!(report.failed[0].message, "disk full");
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "foo");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn unicode_case_matching_has_original_offsets_and_exact_counts() {
        assert_eq!(literal_ranges("İ X x", "x", false), vec![(3, 4), (5, 6)]);
        assert_eq!(
            replace_literal("İ i I", "i", "x", false).unwrap(),
            ("İ x x".into(), 2)
        );
        assert_eq!(
            replace_literal("Foo foo", "foo", "foo", false).unwrap(),
            ("foo foo".into(), 1)
        );
        let dir = tempdir("case-preview");
        fs::write(dir.join("a.md"), "Foo\nfoo\n").unwrap();
        assert_eq!(
            search_tree_with_case(&dir, "Foo", 10, true).unwrap().len(),
            1
        );
        assert_eq!(
            search_tree_with_case(&dir, "Foo", 10, false).unwrap().len(),
            2
        );
        assert_eq!(
            prepare_replacement(&dir, "Foo", "bar", true).unwrap().files[0].count,
            1
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn prefix_matching_preserves_unicode_and_nonoverlapping_semantics() {
        // Independent simple matcher records the existing per-character lowercase
        // contract. It intentionally does not share the prefix table implementation.
        fn reference(hay: &str, needle: &str) -> Vec<(usize, usize)> {
            if needle.is_empty() {
                return Vec::new();
            }
            let mut ranges = Vec::new();
            let mut until = 0;
            for (start, _) in hay.char_indices() {
                if start < until {
                    continue;
                }
                let mut input = hay[start..].char_indices();
                let mut end = start;
                if needle.chars().all(|expected| {
                    input.next().is_some_and(|(offset, actual)| {
                        end = start + offset + actual.len_utf8();
                        actual.to_lowercase().eq(expected.to_lowercase())
                    })
                }) {
                    ranges.push((start, end));
                    until = end;
                }
            }
            ranges
        }
        for hay in [
            "ababababac",
            "aaaaAa",
            "가A가a가b",
            "İ i I",
            "ΣσςΣ",
            "a\nA\n",
            "🙂A🙂a",
            "",
        ] {
            for query in ["ababac", "aa", "가a가b", "i", "İ", "Σ", "🙂a", "\n", ""] {
                let expected = reference(hay, query);
                assert_eq!(
                    literal_ranges(hay, query, false),
                    expected,
                    "{hay:?} / {query:?}"
                );
                assert_eq!(
                    literal_ranges_limited(hay, query, false, 1),
                    expected.into_iter().take(1).collect::<Vec<_>>()
                );
            }
        }
        let text = format!("{}b", "a".repeat(16_384));
        let query = format!("{}b", "A".repeat(1023));
        assert_eq!(literal_ranges(&text, &query, false), vec![(15_361, 16_385)]);
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
        assert_eq!(
            fs::read_to_string(d.join("c.MARKDOWN")).unwrap(),
            "BAZ BAZ\n"
        );
        assert_eq!(out[0].count, 1);
        assert_eq!(out[1].count, 2);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn case_insensitive_preserves_surroundings() {
        let d = tempdir("case");
        fs::write(d.join("a.md"), "Hello hello HELLO\n").unwrap();
        replace_all_tree(&d, "hello", "안녕", false).unwrap();
        assert_eq!(
            fs::read_to_string(d.join("a.md")).unwrap(),
            "안녕 안녕 안녕\n"
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn case_insensitive_multibyte_needle_no_panic() {
        // 한글 검색어 — 옛 구현이 prev를 chars().count()로 밀어 다음 슬라이스가
        // 문자 경계 안(한글 1글자=3바이트)에 떨어져 패닉하던 회귀.
        let out = case_insensitive_replace("한글과 한글", "한글", "글씨");
        assert_eq!(out, "글씨과 글씨");
        // 파일 경로(원자적 저장)에서도 동일하게 — 전체 바꾸기가 죽지 않는다.
        let d = tempdir("ko");
        fs::write(d.join("k.md"), "마크다운은 마크다운을 마크다운이라 한다\n").unwrap();
        let outcomes = replace_all_tree(&d, "마크다운", "Markdown", false).unwrap();
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].count, 3);
        assert_eq!(
            fs::read_to_string(d.join("k.md")).unwrap(),
            "Markdown은 Markdown을 Markdown이라 한다\n"
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn crlf_and_bom_survive_replace() {
        let d = tempdir("meta");
        fs::write(d.join("a.md"), b"\xEF\xBB\xBFfoo\r\nbar\r\n").unwrap();
        replace_all_tree(&d, "foo", "x", true).unwrap();
        assert_eq!(
            fs::read(d.join("a.md")).unwrap(),
            b"\xEF\xBB\xBFx\r\nbar\r\n"
        );
        let _ = fs::remove_dir_all(&d);
    }
}

/// 문서 간선 — 출발 파일 경로 → 실제 대상 파일 경로.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentEdge {
    pub from: String,
    pub to: String,
}

/// Shared resolution with backlinks; exclude self, missing/outside targets and duplicates.
pub fn extract_document_edges(root: &Path) -> std::io::Result<Vec<DocumentEdge>> {
    let (tree, files) = crate::wiki_rename::inventory(root)?;
    let index = crate::wiki_rename::index(&tree);
    let inventory: HashSet<_> = files.iter().map(String::as_str).collect();
    let mut edges = Vec::new();
    let mut remaining = 128 * 1024 * 1024;
    for path in &files {
        let content = read_link_document(Path::new(path), &mut remaining)?;
        let dir = Path::new(path).parent().unwrap_or(root);
        let mut seen = HashSet::new();
        for target in crate::document_links::targets(&content).map_err(std::io::Error::other)? {
            let Some(to) = resolve_document_link(&target.destination, &index, &inventory, dir)
            else {
                continue;
            };
            if to == path || !seen.insert(to) {
                continue;
            }
            if edges.len() >= 100_000 {
                return Err(std::io::Error::other(
                    "Document graph exceeds 100,000 connections. Open a smaller folder.",
                ));
            }
            edges.push(DocumentEdge {
                from: path.clone(),
                to: to.into(),
            });
        }
    }
    Ok(edges)
}
