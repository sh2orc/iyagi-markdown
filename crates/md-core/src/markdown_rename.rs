//! Locate destinations using CommonMark, then splice only original destination bytes.
//! Reference definitions are not exposed in comrak's AST. Synthetic reference uses and
//! marked destinations identify the winning definitions; neither is written to disk.
use crate::{
    links::{self, LinkTarget},
    markdown_source::{self, Edit, Source},
};
use comrak::{nodes::NodeValue, parse_document, Arena};
use std::{collections::HashMap, ops::Range, path::Path};

const UNSUPPORTED: &str = "A Markdown link could not be updated without changing document structure. The document was kept.";

fn encode(text: &str, keep_slashes: bool) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) || (keep_slashes && byte == b'/')
        {
            out.push(byte as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn replacement(url: &str, dir: &Path, from: &Path, to: &Path) -> Result<Option<String>, String> {
    let LinkTarget::Markdown { path, .. } = links::resolve(url, dir) else {
        return Ok(None);
    };
    if path != from {
        return Ok(None);
    }
    let (file, fragment) = url
        .trim()
        .split_once('#')
        .map_or((url.trim(), None), |(f, a)| (f, Some(a)));
    let decoded = links::percent_decode(file).replace('\\', "/");
    let prefix = decoded.rfind('/').map_or("", |i| &decoded[..=i]);
    let name = to.file_name().and_then(|s| s.to_str()).ok_or(UNSUPPORTED)?;
    let mut next = encode(&format!("{prefix}{name}"), true);
    if let Some(fragment) = fragment {
        next.push('#');
        // The parser has already decoded entities/backslash escapes. Keep URL escapes
        // and Unicode in the anchor, encoding only Markdown-sensitive characters.
        for c in fragment.chars() {
            if c.is_whitespace()
                || matches!(
                    c,
                    '(' | ')' | '<' | '>' | '"' | '\'' | '\\' | '&' | '[' | ']'
                )
            {
                next.push_str(&encode(&c.to_string(), false));
            } else {
                next.push(c);
            }
        }
    }
    match links::resolve(&next, dir) {
        LinkTarget::Markdown { path, .. } if path == to => Ok(Some(next)),
        _ => Err(UNSUPPORTED.into()),
    }
}

// Return only the bytes inside an optional <...> wrapper.
fn destination(text: &str, mut at: usize) -> Option<Range<usize>> {
    let b = text.as_bytes();
    let whitespace_start = at;
    while b.get(at).is_some_and(u8::is_ascii_whitespace) {
        at += 1;
        if at - whitespace_start > 4096 {
            return None;
        }
    }
    if b.get(at) == Some(&b'<') {
        let start = at + 1;
        at = start;
        while let Some(&c) = b.get(at) {
            if at - start > 16 * 1024 {
                return None;
            }
            if c == b'\\' && b.get(at + 1).is_some_and(u8::is_ascii_punctuation) {
                at += 2;
                continue;
            }
            if c == b'>' {
                return Some(start..at);
            }
            if matches!(c, b'\n' | b'\r' | b'<') {
                return None;
            }
            at += 1;
        }
        return None;
    }
    let start = at;
    let mut depth = 0usize;
    while let Some(&c) = b.get(at) {
        if at - start > 16 * 1024 {
            return None;
        }
        if c == b'\\' && b.get(at + 1).is_some_and(u8::is_ascii_punctuation) {
            at += 2;
            continue;
        }
        if c.is_ascii_whitespace() || (c == b')' && depth == 0) {
            break;
        }
        if c == b'(' {
            depth += 1;
        }
        if c == b')' {
            depth -= 1;
        }
        at += 1;
    }
    (at > start && depth == 0).then_some(start..at)
}

fn inline_destination(raw: &str) -> Option<Range<usize>> {
    if raw.len() > 64 * 1024 {
        return None;
    }
    let b = raw.as_bytes();
    let mut at = usize::from(b.first() == Some(&b'!'));
    if b.get(at) != Some(&b'[') {
        return None;
    }
    at += 1;
    let mut depth = 1;
    while at < b.len() {
        match b[at] {
            b'\\' if b.get(at + 1).is_some_and(u8::is_ascii_punctuation) => {
                at += 2;
                continue;
            }
            b'`' => {
                let start = at;
                while b.get(at) == Some(&b'`') {
                    at += 1;
                }
                let width = at - start;
                let mut scan = at;
                while scan < b.len() {
                    if b[scan] != b'`' {
                        scan += 1;
                        continue;
                    }
                    let run = scan;
                    while b.get(scan) == Some(&b'`') {
                        scan += 1;
                    }
                    if scan - run == width {
                        at = scan;
                        break;
                    }
                }
                continue;
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return (b.get(at + 1) == Some(&b'('))
                        .then(|| destination(raw, at + 2))
                        .flatten();
                }
            }
            _ => {}
        }
        at += 1;
    }
    None
}

struct Definition {
    label: String,
    destination: Option<Range<usize>>,
}

// This is only a candidate scanner. The parser decides whether a definition is
// active, ignored, code, HTML, or ordinary text, including duplicate-label precedence.
fn definitions(text: &str) -> Result<Vec<Definition>, String> {
    let b = text.as_bytes();
    let mut out = Vec::new();
    for (attempt, (start, _)) in text.match_indices('[').enumerate() {
        if attempt >= 20_000 {
            return Err("Too many link labels to review safely".into());
        }
        let mut end = start + 1;
        while end < b.len() && end - start <= 4_000 {
            if b[end] == b'\\' && b.get(end + 1).is_some_and(u8::is_ascii_punctuation) {
                end += 2;
                continue;
            }
            if matches!(b[end], b'[' | b']') {
                break;
            }
            end += 1;
        }
        if b.get(end) != Some(&b']') || b.get(end + 1) != Some(&b':') {
            continue;
        }
        let label = &text[start + 1..end];
        if label.trim().is_empty() || label.starts_with('^') {
            continue;
        }
        out.push(Definition {
            label: label.into(),
            destination: destination(text, end + 2),
        });
        if out.len() > 512 {
            return Err("Reference-link review exceeds 512 definitions in one document".into());
        }
    }
    Ok(out)
}

fn probe_urls(text: &str, probe_lines: &HashMap<usize, usize>) -> HashMap<usize, String> {
    let arena = Arena::new();
    let options = markdown_source::options();
    let root = parse_document(&arena, text, &options);
    let mut urls = HashMap::new();
    for node in root.descendants() {
        let data = node.data.borrow();
        if data.sourcepos.start.column != 1 {
            continue;
        }
        if let (Some(&i), NodeValue::Link(link)) =
            (probe_lines.get(&data.sourcepos.start.line), &data.value)
        {
            urls.insert(i, link.url.clone());
        }
    }
    urls
}

pub(crate) fn edits(text: &str, dir: &Path, from: &Path, to: &Path) -> Result<Vec<Edit>, String> {
    let source = Source::new(text);
    let options = markdown_source::options();
    let arena = Arena::new();
    let root = parse_document(&arena, &source.masked, &options);
    let mut edits = Vec::new();
    let mut affected = false;
    for node in root.descendants() {
        let data = node.data.borrow();
        let link = match &data.value {
            NodeValue::Link(link) | NodeValue::Image(link) => link,
            _ => continue,
        };
        let Some(value) = replacement(&link.url, dir, from, to)? else {
            continue;
        };
        affected = true;
        let range = source.range(data.sourcepos)?;
        let raw = text.get(range.clone()).ok_or(UNSUPPORTED)?;
        if let Some(dest) = inline_destination(raw) {
            edits.push(Edit {
                range: range.start + dest.start..range.start + dest.end,
                value,
            });
        }
        // Reference uses have no inline destination; their definitions are handled below.
    }
    let defs = definitions(&source.masked)?;
    let mut prefix = String::new();
    let mut probe_lines = HashMap::new();
    let mut line = 1;
    for (i, def) in defs.iter().enumerate() {
        probe_lines.insert(line, i);
        let probe = format!("[iyagi-probe-{i}][{}]\n\n", def.label);
        line += probe.bytes().filter(|b| *b == b'\n').count();
        prefix.push_str(&probe);
        if prefix.len() > 256 * 1024 {
            return Err("Reference-link review labels exceed 256 KiB".into());
        }
    }
    let original = format!("{prefix}{}", source.masked);
    let original_urls = if defs.is_empty() {
        HashMap::new()
    } else {
        probe_urls(&original, &probe_lines)
    };
    let mut reference_changes = HashMap::new();
    for (i, url) in &original_urls {
        if let Some(value) = replacement(url, dir, from, to)? {
            reference_changes.insert(*i, value);
        }
    }
    if !reference_changes.is_empty() {
        affected = true;
        let marker = (0..1024)
            .map(|n| format!("iyagi-rename-probe-{n}-"))
            .find(|candidate| !text.contains(candidate))
            .ok_or(UNSUPPORTED)?;
        let mut markers = HashMap::new();
        let mut marked_edits = Vec::new();
        for (i, def) in defs.iter().enumerate() {
            if let Some(range) = &def.destination {
                let value = format!("{marker}{i}");
                markers.insert(value.clone(), i);
                marked_edits.push(Edit {
                    range: range.clone(),
                    value,
                });
            }
        }
        // Ambiguous/overlapping candidates fail closed; they never reach a file write.
        let marked = markdown_source::apply(&source.masked, &mut marked_edits)?;
        let marked_urls = probe_urls(&format!("{prefix}{marked}"), &probe_lines);
        let mut selected = HashMap::new();
        for (i, value) in reference_changes {
            let target = marked_urls
                .get(&i)
                .and_then(|url| markers.get(url))
                .ok_or(UNSUPPORTED)?;
            selected.insert(*target, value);
        }
        for (i, value) in selected {
            edits.push(Edit {
                range: defs[i].destination.clone().ok_or(UNSUPPORTED)?,
                value,
            });
        }
    }
    if !affected {
        return Ok(Vec::new());
    }
    let after = markdown_source::apply(text, &mut edits)?;
    let after_source = Source::new(&after);
    // Compare the actual document independently of the probes: synthetic references
    // must not hide a real use by consuming the parser's reference-expansion budget.
    // Only URLs resolving to the renamed document may change.
    let before_arena = Arena::new();
    let after_arena = Arena::new();
    let before_root = parse_document(&before_arena, &source.masked, &options);
    let after_root = parse_document(&after_arena, &after_source.masked, &options);
    let mut before_nodes = before_root.traverse();
    let mut after_nodes = after_root.traverse();
    use comrak::arena_tree::NodeEdge;
    loop {
        match (before_nodes.next(), after_nodes.next()) {
            (None, None) => break,
            (Some(NodeEdge::Start(a)), Some(NodeEdge::Start(b))) => {
                let mut expected = a.data.borrow().value.clone();
                if let NodeValue::Link(link) | NodeValue::Image(link) = &mut expected {
                    if let Some(value) = replacement(&link.url, dir, from, to)? {
                        link.url = value;
                    }
                }
                if expected != b.data.borrow().value {
                    return Err(UNSUPPORTED.into());
                }
            }
            (Some(NodeEdge::End(_)), Some(NodeEdge::End(_))) => {}
            _ => return Err(UNSUPPORTED.into()),
        }
    }
    if !defs.is_empty() {
        let mut expected = original_urls;
        for url in expected.values_mut() {
            if let Some(value) = replacement(url, dir, from, to)? {
                *url = value;
            }
        }
        if probe_urls(&format!("{prefix}{}", after_source.masked), &probe_lines) != expected {
            return Err(UNSUPPORTED.into());
        }
    }
    Ok(edits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rewrite(text: &str, old: &str, new: &str) -> Result<(String, usize), String> {
        let dir = Path::new("/workspace/notes");
        let mut changes = edits(text, dir, &dir.join(old), &dir.join(new))?;
        let count = changes.len();
        Ok((markdown_source::apply(text, &mut changes)?, count))
    }

    #[test]
    fn inline_destinations_preserve_labels_titles_and_anchors() {
        let input = "한글 [**설명**](./old.md#개요 \"제목\")\n[다른 문구](<old.md#한글> '설명')\n![설명](old.md)\n";
        let (after, count) = rewrite(input, "old.md", "new name#.md").unwrap();
        assert_eq!(count, 3);
        assert_eq!(after, "한글 [**설명**](./new%20name%23.md#개요 \"제목\")\n[다른 문구](<new%20name%23.md#한글> '설명')\n![설명](new%20name%23.md)\n");
    }

    #[test]
    fn nested_labels_code_spans_and_parentheses_do_not_confuse_destination() {
        let input = "[a [b] `](`](old(a).md \"title ](example\")\n[escaped](old\\(a\\).md)\n";
        let (after, count) = rewrite(input, "old(a).md", "new(b).md").unwrap();
        assert_eq!(count, 2);
        assert_eq!(
            after,
            "[a [b] `](`](new%28b%29.md \"title ](example\")\n[escaped](new%28b%29.md)\n"
        );
    }

    #[test]
    fn only_the_actual_local_path_is_selected() {
        let input = "[local](old.md) [other](../other/old.md) [web](https://host/old.md)\n\
            [anchor](#old.md) [file](file:///workspace/notes/old.md) [asset](old.png)\n";
        let (after, count) = rewrite(input, "old.md", "new.md").unwrap();
        assert_eq!(count, 1);
        assert_eq!(after, input.replacen("(old.md)", "(new.md)", 1));
        let absolute = "[absolute](/workspace/notes/old.md#section)";
        assert_eq!(
            rewrite(absolute, "old.md", "new.md").unwrap().0,
            "[absolute](/workspace/notes/new.md#section)"
        );
    }

    #[test]
    fn percent_encoding_entities_and_escaped_filenames_resolve_before_matching() {
        let input = "[한글](%EC%98%9B%20%26%20%EC%9D%B4%EB%A6%84.md#section%20one)\n\
            [entity](<옛 &amp; 이름.md>)\n";
        let (after, count) = rewrite(input, "옛 & 이름.md", "새 이름.md").unwrap();
        assert_eq!(count, 2);
        assert_eq!(
            after,
            "[한글](%EC%83%88%20%EC%9D%B4%EB%A6%84.md#section%20one)\n\
            [entity](<%EC%83%88%20%EC%9D%B4%EB%A6%84.md>)\n"
        );
    }

    #[test]
    fn reference_definitions_preserve_uses_titles_and_duplicate_precedence() {
        let input =
            "[text][ID] [id][] [id]\n\n[id]: ./old.md#heading \"title\"\n[id]: other.md\n\n\
            [unused]: <old.md> 'unused title'\n";
        let (after, count) = rewrite(input, "old.md", "new.md").unwrap();
        assert_eq!(count, 2); // One destination per definition, not per use.
        assert_eq!(
            after,
            input
                .replace("./old.md#heading", "./new.md#heading")
                .replace("<old.md>", "<new.md>")
        );
        let ignored = "[id]\n\n[id]: other.md\n[id]: old.md\n";
        assert_eq!(
            rewrite(ignored, "old.md", "new.md").unwrap(),
            (ignored.into(), 0)
        );
    }

    #[test]
    fn reference_labels_use_parser_normalization_and_multiline_destinations() {
        let input = "[text][A B]\n\n[a  b]:\n  <old.md#heading>\n  \"keep title\"\n\n\
            > [quote]: old.md\n>\n> [quote]\n\n- [list]: old.md\n\n  [list]\n";
        let (after, count) = rewrite(input, "old.md", "new.md").unwrap();
        assert_eq!(count, 3);
        assert_eq!(after, input.replace("old.md", "new.md"));
    }

    #[test]
    fn escaped_and_multiline_reference_labels_keep_their_source() {
        let input = "[text][a\\]b] [other][two words]\n\n[a\\]b]: old.md\n[two\nwords]: old.md\n";
        let (after, count) = rewrite(input, "old.md", "new.md").unwrap();
        assert_eq!(count, 2);
        assert_eq!(after, input.replace("old.md", "new.md"));
    }

    #[test]
    fn code_html_math_and_metadata_examples_are_not_rewritten() {
        let input = "---\nlink: '[example](old.md)'\n---\n\
            `[inline](old.md)`\n\n```md\n[example](old.md)\n[code]: old.md\n```\n\n\
            \x20\x20\x20\x20[indented](old.md)\n\n<!-- [html](old.md) -->\n\n\
            $[math](old.md)$\n\n[actual](old.md)\n\n[real]: old.md\n\n```\nunclosed [real]\n";
        let (after, count) = rewrite(input, "old.md", "new.md").unwrap();
        assert_eq!(count, 2);
        assert_eq!(
            after,
            input
                .replace("[actual](old.md)", "[actual](new.md)")
                .replace("[real]: old.md", "[real]: new.md")
        );
        let metadata = "---\nlink: '[example](old.md)'\n";
        assert_eq!(
            rewrite(metadata, "old.md", "new.md").unwrap(),
            (metadata.into(), 0)
        );
    }

    #[test]
    fn paragraph_lookalikes_cannot_become_reference_definitions() {
        let input = "paragraph\n[not-a-definition]: old.md\n\n[real]: old.md\n\n[real]\n";
        let (after, count) = rewrite(input, "old.md", "new.md").unwrap();
        assert_eq!(count, 1);
        assert_eq!(after, input.replace("[real]: old.md", "[real]: new.md"));
    }

    #[test]
    fn unsupported_source_mapping_keeps_the_entire_file() {
        // A container prefix interrupts the lexical destination span. The parser
        // still resolves the reference; the complete-tree comparison must reject
        // leaving that old URL behind.
        let input = "> [id]:\n>   old.md\n>\n> [id]\n";
        assert!(rewrite(input, "old.md", "new.md").is_err());
    }

    #[test]
    fn ambiguous_or_unrepresentable_ranges_fail_closed() {
        assert!(rewrite("[x](old.md)", "old.md", "new\\name.md").is_err());
        let input = (0..513)
            .map(|i| format!("[id{i}]: old.md\n"))
            .collect::<String>();
        assert!(rewrite(&input, "old.md", "new.md").is_err());
    }
}
