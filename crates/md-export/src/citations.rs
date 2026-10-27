//! Citation preprocessing for DOCX. Bibliography definitions become visible
//! paragraphs and citations become ordinary Markdown links, so OOXML is
//! always built by the inline renderer rather than spliced into serialized text.

use std::collections::{HashMap, HashSet};
use std::ops::Range;

use comrak::{nodes::NodeValue, parse_document, Arena, Options};

pub(crate) const CITATION_TITLE: &str = "iyagi:citation";

#[derive(Default)]
pub struct Citations {
    /// Rewritten Markdown, preserving line count and trailing newline.
    pub md: String,
    pub defs: Vec<(String, String)>,
    /// Canonical bibliography line for each key (last definition wins).
    pub lines: HashMap<u32, String>,
    pub nums: HashMap<String, usize>,
}

fn parse_def(line: &str) -> Option<(String, String)> {
    let rest = line.trim_start().strip_prefix("[@")?;
    let close = rest.find(']')?;
    let key = &rest[..close];
    if key.is_empty() || key.contains(char::is_whitespace) || key.contains('[') {
        return None;
    }
    Some((
        key.to_string(),
        rest[close + 1..]
            .strip_prefix(':')?
            .trim_start()
            .to_string(),
    ))
}

/// Prevent bibliography candidates from being consumed as Markdown reference
/// definitions during the protection pass. Replacing '[' keeps byte positions.
fn protected_ranges(markdown: &str) -> Vec<Range<usize>> {
    let mut masked = markdown.as_bytes().to_vec();
    let starts: Vec<_> = std::iter::once(0)
        .chain(markdown.match_indices('\n').map(|(i, _)| i + 1))
        .collect();
    for (index, line) in markdown.split('\n').enumerate() {
        if parse_def(line).is_some() {
            let offset = line.len() - line.trim_start().len();
            masked[starts[index] + offset] = b'x';
        }
    }
    let masked = String::from_utf8(masked).expect("ASCII replacement preserves UTF-8");
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.math_dollars = true;
    options.extension.footnotes = true;
    options.parse.leave_footnote_definitions = true;
    options.parse.escaped_char_spans = true;
    let arena = Arena::new();
    let root = parse_document(&arena, &masked, &options);
    let mut ranges = Vec::new();
    for node in root.descendants() {
        let data = node.data.borrow();
        let protected = matches!(
            data.value,
            NodeValue::CodeBlock(_)
                | NodeValue::Code(_)
                | NodeValue::HtmlBlock(_)
                | NodeValue::HtmlInline(_)
                | NodeValue::Link(_)
                | NodeValue::Image(_)
                | NodeValue::Math(_)
                | NodeValue::Escaped
        ) || matches!(&data.value, NodeValue::FootnoteDefinition(note) if note.total_references == 0);
        if !protected {
            continue;
        }
        let pos = data.sourcepos;
        let Some(start_line) = pos.start.line.checked_sub(1).and_then(|i| starts.get(i)) else {
            continue;
        };
        let Some(end_line) = pos.end.line.checked_sub(1).and_then(|i| starts.get(i)) else {
            continue;
        };
        let start = start_line + pos.start.column.saturating_sub(1);
        let end = end_line + pos.end.column;
        if start < end && end <= markdown.len() {
            ranges.push(start..end);
        }
    }
    ranges.sort_by_key(|range| range.start);
    let mut merged: Vec<Range<usize>> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut().filter(|last| range.start <= last.end) {
            last.end = last.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    merged
}

fn intersects(ranges: &[Range<usize>], range: Range<usize>) -> bool {
    let at = ranges.partition_point(|protected| protected.end <= range.start);
    ranges
        .get(at)
        .is_some_and(|protected| protected.start < range.end)
}

struct Reference {
    range: Range<usize>,
    key: String,
    suffix: String,
}

fn references(line: &str, offset: usize, protected: &[Range<usize>]) -> Vec<Reference> {
    let mut refs = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = line[cursor..].find("[@") {
        let start = cursor + relative;
        cursor = start + 2;
        let Some(close) = line[cursor..].find(']') else {
            break;
        };
        let end = cursor + close + 1;
        let inner = &line[cursor..end - 1];
        let (key, suffix) = inner.split_once(',').unwrap_or((inner, ""));
        let key = key.trim();
        if key.is_empty()
            || key.contains(char::is_whitespace)
            || inner.contains('[')
            || line[..start].ends_with('[')
            || line[end..].starts_with(']')
            || intersects(protected, offset + start..offset + end)
        {
            continue;
        }
        refs.push(Reference {
            range: start..end,
            key: key.to_string(),
            suffix: suffix.trim().to_string(),
        });
        cursor = end;
    }
    refs
}

fn markdown_label(text: &str) -> String {
    let mut escaped = String::new();
    for ch in text.chars() {
        if ch.is_ascii_punctuation() {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

/// 인용 바로 바깥을 감싼 강조 마커(`**`·`*`·`***`·`_` 계열·`~~`) —
/// 같은 마커가 열림·닫힘으로 정확히 붙어 있을 때만 그 마커를 돌려준다.
/// CommonMark 플랭킹 규칙상 `**[…](…)**글자`는 Strong으로 파싱되지 않는다
/// (닫는 `**` 앞이 문장부호 `)`, 뒤가 글자) — 한국어 붙여쓰기에서 항상 그렇다.
/// 마커를 막을 안으로 옮기면 `[**\[…\]**](…)` 뒤에 `]`가 와서 파싱된다.
fn emphasis_wrapper(line: &str, start: usize, end: usize) -> Option<&'static str> {
    let bytes = line.as_bytes();
    for marker in ["***", "**", "___", "__", "~~", "*", "_"] {
        let m = marker.as_bytes();
        if start < m.len() || !bytes[start - m.len()..start].eq(m) {
            continue;
        }
        if !line[end..].starts_with(marker) {
            continue;
        }
        // 런의 일부만 다루지 않는다 — 같은 글자가 더 이어지면 건너뛴다.
        let run_char = m[0];
        if start > m.len()
            && (bytes[start - m.len() - 1] == run_char || bytes[start - m.len() - 1] == b'\\')
        {
            continue;
        }
        if bytes.get(end + m.len()) == Some(&run_char) {
            continue;
        }
        return Some(marker);
    }
    None
}

fn fragment_key(key: &str) -> String {
    use std::fmt::Write as _;
    let mut encoded = String::new();
    for byte in key.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

impl Citations {
    pub fn extract(markdown: &str) -> Citations {
        if !markdown.contains("[@") {
            return Citations {
                md: markdown.to_string(),
                ..Citations::default()
            };
        }
        let protected = protected_ranges(markdown);
        let rows: Vec<_> = markdown.split('\n').collect();
        let mut definitions = HashMap::new();
        let mut canonical = HashMap::new();
        let mut found = Vec::new();
        let mut result = Citations::default();
        let mut offset = 0;
        for (index, line) in rows.iter().enumerate() {
            let start = offset + line.len() - line.trim_start().len();
            if let Some(definition) =
                parse_def(line).filter(|_| !intersects(&protected, start..start + 2))
            {
                canonical.insert(definition.0.clone(), index as u32 + 1);
                result.defs.push(definition.clone());
                definitions.insert(index, definition);
                found.push(Vec::new());
            } else {
                found.push(references(line, offset, &protected));
            }
            offset += line.len() + 1;
        }
        result.lines = canonical
            .iter()
            .map(|(key, line)| (*line, key.clone()))
            .collect();
        let mut seen = HashSet::new();
        for reference in found.iter().flatten() {
            if canonical.contains_key(&reference.key) && seen.insert(reference.key.clone()) {
                result.nums.insert(reference.key.clone(), seen.len());
            }
        }
        for (index, line) in rows.iter().enumerate() {
            if index > 0 {
                result.md.push('\n');
            }
            if let Some((key, entry)) = definitions.get(&index) {
                result
                    .md
                    .push_str(&line[..line.len() - line.trim_start().len()]);
                if let Some(number) = result.nums.get(key) {
                    result.md.push_str(&format!("[{number}] "));
                }
                result.md.push_str(entry);
                continue;
            }
            let mut cursor = 0;
            for reference in &found[index] {
                let Some(number) = result.nums.get(&reference.key) else {
                    continue;
                };
                let marker = emphasis_wrapper(line, reference.range.start, reference.range.end);
                let opener = marker.map_or(0, str::len);
                result
                    .md
                    .push_str(&line[cursor..reference.range.start - opener]);
                let display = if reference.suffix.is_empty() {
                    format!("[{number}]")
                } else {
                    format!("[{number}, {}]", reference.suffix)
                };
                let label = match marker {
                    Some(marker) => format!("{marker}{}{marker}", markdown_label(&display)),
                    None => markdown_label(&display),
                };
                result.md.push_str(&format!(
                    "[{}](<#ref-{}> \"{CITATION_TITLE}\")",
                    label,
                    fragment_key(&reference.key)
                ));
                cursor = reference.range.end + opener;
            }
            result.md.push_str(&line[cursor..]);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbering_links_and_last_definition_keep_line_positions() {
        let source = "연구 [@kim]와 [@lee, p. 12].\n\n[@kim]: Old.\n[@kim]: Kim.\n[@lee]: Lee.\n";
        let citations = Citations::extract(source);
        assert_eq!(citations.nums.get("kim"), Some(&1));
        assert_eq!(citations.nums.get("lee"), Some(&2));
        assert_eq!(citations.lines.get(&4).map(String::as_str), Some("kim"));
        assert!(!citations.lines.contains_key(&3));
        assert!(citations.md.contains("[1] Old.\n[1] Kim.\n[2] Lee.\n"));
        assert!(citations.md.contains("<#ref-kim>"));
        assert_eq!(
            citations.md.matches('\n').count(),
            source.matches('\n').count()
        );
        assert_eq!(
            Citations::extract("끊긴 [@ghost,  p. 1] 인용").md,
            "끊긴 [@ghost,  p. 1] 인용"
        );
    }

    #[test]
    fn parser_protects_literal_contexts_and_fence_lengths() {
        let literal = concat!(
            "````markdown\n```\n[@fake]: Fake.\n[@real]\n````\n\n",
            "    [@fake]: Indented.\n    [@real]\n\n",
            "`[@real]` \\[@real] [label [@real]](https://example.com) ![[@real]](a.png)\n\n",
            "$[@real]$\n\n<!-- [@fake]: HTML. -->\n\n",
        );
        let source = format!("{literal}actual [@real].\n\n[@real]: R.\n");
        let citations = Citations::extract(&source);
        assert!(citations.md.starts_with(literal));
        assert_eq!(citations.defs, [("real".to_string(), "R.".to_string())]);
        assert_eq!(citations.nums.get("real"), Some(&1));
        assert_eq!(citations.md.matches(CITATION_TITLE).count(), 1);
    }

    #[test]
    fn unused_notes_do_not_consume_numbers_and_definitions_keep_inline_code() {
        let source = concat!(
            "used[^note]\n\n[^note]: [@b]\n\n[^unused]: [@a]\n\n",
            "- entry\n\n  [@a]: `A`\n  [@b]: **B**\n",
        );
        let citations = Citations::extract(source);
        assert_eq!(citations.nums.get("b"), Some(&1));
        assert!(!citations.nums.contains_key("a"));
        assert!(citations.md.contains("[^unused]: [@a]"));
        assert!(citations.md.ends_with("  `A`\n  [1] **B**\n"));
    }

    #[test]
    fn emphasis_wrapping_a_citation_moves_inside_the_link_label() {
        // `**[@a]**글자` 는 플랭킹 규칙(닫는 ** 앞 문장부호·뒤 글자) 때문에
        // Strong이 되지 않는다 — 마커를 막을 안으로 옮겨 파싱되게 한다.
        let source = "**[@a]**와 [@a] 일반 ***[@a]***끝 __[@a]__붙음 ~~[@a]~~취소.\n\n[@a]: A.\n";
        let citations = Citations::extract(source);
        assert!(citations
            .md
            .contains("[**\\[1\\]**](<#ref-a> \"iyagi:citation\")와"));
        assert!(citations
            .md
            .contains("[\\[1\\]](<#ref-a> \"iyagi:citation\") 일반"));
        assert!(citations
            .md
            .contains("[***\\[1\\]***](<#ref-a> \"iyagi:citation\")끝"));
        assert!(citations
            .md
            .contains("[__\\[1\\]__](<#ref-a> \"iyagi:citation\")붙음"));
        assert!(citations
            .md
            .contains("[~~\\[1\\]~~](<#ref-a> \"iyagi:citation\")취소"));
        // 줄 수 보존은 그대로 — 문서 좌표가 흔들리지 않는다.
        assert_eq!(
            citations.md.matches('\n').count(),
            source.matches('\n').count()
        );
        // 짝이 맞지 않거나(여는 **만) 더 긴 런(****)은 건드리지 않는다.
        let partial = Citations::extract("**[@a] 단독과 ****[@a]****긴.\n\n[@a]: A.\n");
        assert!(partial.md.contains("**[\\[1\\]](<#ref-a>"));
        assert!(partial.md.contains("****[\\[1\\]](<#ref-a>"));
    }
}
