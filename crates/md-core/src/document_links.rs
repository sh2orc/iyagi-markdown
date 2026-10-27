//! Link uses in original source order, shared by rename, backlinks, and graph scans.
use crate::markdown_source::{self, Source};
use comrak::{nodes::NodeValue, parse_document, Arena};

pub(crate) enum Destination {
    Wiki(String),
    Url(String),
}

pub(crate) struct Target {
    pub destination: Destination,
    pub start: usize,
    pub end: usize,
    pub line: usize,
}

pub(crate) fn targets(text: &str) -> Result<Vec<Target>, String> {
    let arena = Arena::new();
    let options = markdown_source::options();
    let source = Source::new(text);
    let root = parse_document(&arena, &source.masked, &options);
    let mut targets = Vec::new();
    for node in root.descendants() {
        let data = node.data.borrow();
        match &data.value {
            NodeValue::WikiLink(_) => {
                let pos = data.sourcepos;
                if pos.start.line != pos.end.line {
                    continue;
                }
                let range = source.range(pos)?;
                let raw = text
                    .get(range.clone())
                    .ok_or("Invalid wiki-link source range")?;
                let inner = raw
                    .strip_prefix("[[")
                    .and_then(|s| s.strip_suffix("]]"))
                    .ok_or("Unsupported wiki-link source range. The document was kept.")?;
                let name = &inner[..inner.find(['#', '|']).unwrap_or(inner.len())];
                let trimmed = name.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let start = range.start + 2 + name.len() - name.trim_start().len();
                targets.push(Target {
                    destination: Destination::Wiki(trimmed.into()),
                    start,
                    end: start + trimmed.len(),
                    line: pos.start.line,
                });
            }
            NodeValue::Link(link) | NodeValue::Image(link) => {
                let range = source.range(data.sourcepos)?;
                // For reference links the parser supplies the resolved URL, while
                // the range identifies the use, not the distant definition.
                targets.push(Target {
                    destination: Destination::Url(link.url.clone()),
                    start: range.start,
                    end: range.end,
                    line: data.sourcepos.start.line,
                });
            }
            _ => {}
        }
    }
    targets.sort_by_key(|target| target.start);
    Ok(targets)
}
