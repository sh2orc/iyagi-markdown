//! Source-preserving edits. Parser positions use one-based UTF-8 byte columns.
use comrak::{nodes::Sourcepos, Options};
use std::ops::Range;

pub(crate) fn options() -> Options<'static> {
    let mut options = Options::default();
    options.extension.wikilinks_title_after_pipe = true;
    options.extension.table = true;
    options.extension.footnotes = true;
    options.extension.strikethrough = true;
    options.extension.math_dollars = true;
    options
}

pub(crate) struct Source {
    pub masked: String,
    starts: Vec<usize>,
}

impl Source {
    pub fn new(text: &str) -> Self {
        let starts = std::iter::once(0)
            .chain(text.match_indices('\n').map(|(i, _)| i + 1))
            .collect();
        // Preserve metadata, including an unclosed block, without shifting source positions.
        let front_end = if text.starts_with("---\n") {
            text.split_inclusive('\n')
                .skip(1)
                .scan(4usize, |offset, line| {
                    *offset += line.len();
                    Some((*offset, line.trim_end_matches('\n')))
                })
                .find(|(_, line)| *line == "---" || *line == "...")
                .map(|(end, _)| end)
                .unwrap_or(text.len())
        } else {
            0
        };
        let mut bytes = text.as_bytes().to_vec();
        for byte in &mut bytes[..front_end] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
        Self {
            masked: String::from_utf8(bytes).expect("Mask preserves UTF-8"),
            starts,
        }
    }

    pub fn range(&self, pos: Sourcepos) -> Result<Range<usize>, String> {
        let start = self
            .starts
            .get(pos.start.line.checked_sub(1).ok_or("Missing source line")?)
            .ok_or("Invalid source line")?
            + pos.start.column.saturating_sub(1);
        let end = self
            .starts
            .get(pos.end.line.checked_sub(1).ok_or("Missing source line")?)
            .ok_or("Invalid source line")?
            + pos.end.column;
        self.masked
            .get(start..end)
            .ok_or("Invalid source byte range")?;
        Ok(start..end)
    }
}

#[derive(Clone)]
pub(crate) struct Edit {
    pub range: Range<usize>,
    pub value: String,
}

pub(crate) fn apply(text: &str, edits: &mut [Edit]) -> Result<String, String> {
    edits.sort_by_key(|edit| edit.range.start);
    let mut cursor = 0;
    let mut size = text.len();
    for edit in edits.iter() {
        if edit.range.start < cursor || text.get(edit.range.clone()).is_none() {
            return Err("Overlapping or invalid link ranges. The document was kept.".into());
        }
        size = size
            .saturating_sub(edit.range.len())
            .saturating_add(edit.value.len());
        cursor = edit.range.end;
    }
    if size > 16 * 1024 * 1024 {
        return Err("Link replacement output exceeds 16 MiB".into());
    }
    let mut out = String::with_capacity(size);
    cursor = 0;
    for edit in edits {
        out.push_str(&text[cursor..edit.range.start]);
        out.push_str(&edit.value);
        cursor = edit.range.end;
    }
    out.push_str(&text[cursor..]);
    Ok(out)
}
