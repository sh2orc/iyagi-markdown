use std::collections::BTreeMap;
use std::fmt::Write as _;

/// Every note is kept, including multiple notes on one line. Child blocks claim
/// their source lines before parents, so references are emitted only once.
#[derive(Default)]
pub(crate) struct DocxComments {
    pending: BTreeMap<usize, Vec<(u64, String)>>,
    attached: Vec<(u64, String)>,
}

impl DocxComments {
    pub fn new(comments: &[(u32, String)], line_count: usize) -> Result<Self, String> {
        let mut out = Self::default();
        for (index, (line, text)) in comments.iter().enumerate() {
            if *line == 0 || *line as usize > line_count {
                return Err(format!("메모의 줄 번호가 문서 범위를 벗어났습니다: {line}"));
            }
            out.pending
                .entry(*line as usize)
                .or_default()
                .push((index as u64 + 1, text.clone()));
        }
        Ok(out)
    }

    pub fn is_empty(&self) -> bool {
        self.attached.is_empty()
    }

    /// Attach to the first generated paragraph in this block. Empty/omitted
    /// blocks get an empty paragraph at their original position.
    pub fn attach(&mut self, first: usize, last: usize, out: &mut String, from: usize) {
        if first > last {
            return;
        }
        let lines: Vec<_> = self
            .pending
            .range(first..=last)
            .map(|(&line, _)| line)
            .collect();
        if lines.is_empty() {
            return;
        }
        let mut notes = Vec::new();
        for line in lines {
            notes.extend(self.pending.remove(&line).unwrap_or_default());
        }
        let p = match out[from..].find("<w:p>") {
            Some(offset) => from + offset + "<w:p>".len(),
            None => {
                let offset = out.len();
                out.push_str("<w:p></w:p>");
                offset + "<w:p>".len()
            }
        };
        // Paragraph properties must remain first.
        let start = if out[p..].starts_with("<w:pPr>") {
            p + out[p..]
                .find("</w:pPr>")
                .expect("generated paragraph properties")
                + "</w:pPr>".len()
        } else if out[p..].starts_with("<w:pPr/>") {
            p + "<w:pPr/>".len()
        } else {
            p
        };
        let end = start
            + out[start..]
                .find("</w:p>")
                .expect("generated paragraph end");
        let mut starts = String::new();
        let mut ends = String::new();
        for (id, _) in &notes {
            let _ = write!(starts, "<w:commentRangeStart w:id=\"{id}\"/>");
        }
        for (id, _) in notes.iter().rev() {
            let _ = write!(ends, "<w:commentRangeEnd w:id=\"{id}\"/>");
        }
        for (id, _) in &notes {
            let _ = write!(ends, "<w:r><w:rPr><w:rStyle w:val=\"CommentReference\"/></w:rPr><w:commentReference w:id=\"{id}\"/></w:r>");
        }
        out.insert_str(end, &ends);
        out.insert_str(start, &starts);
        self.attached.extend(notes);
    }

    pub fn xml(&self) -> String {
        let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:comments xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">");
        let mut notes: Vec<_> = self.attached.iter().collect();
        notes.sort_by_key(|(id, _)| *id);
        for (id, text) in notes {
            let _ = write!(out,
                "<w:comment w:id=\"{id}\" w:author=\"IYAGI Markdown\" w:initials=\"IY\"><w:p><w:pPr><w:pStyle w:val=\"CommentText\"/></w:pPr><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p></w:comment>",
                crate::xml::esc(text));
        }
        out.push_str("</w:comments>");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_line_notes_are_nested_and_claimed_only_once() {
        let mut comments = DocxComments::new(&[(2, "one".into()), (2, "two".into())], 3).unwrap();
        let mut out =
            "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>"
                .to_string();
        comments.attach(2, 2, &mut out, 0);
        let once = out.clone();
        comments.attach(1, 3, &mut out, 0);
        assert_eq!(out, once);
        assert!(out.contains(
            "</w:pPr><w:commentRangeStart w:id=\"1\"/><w:commentRangeStart w:id=\"2\"/>"
        ));
        assert!(out.contains("<w:commentRangeEnd w:id=\"2\"/><w:commentRangeEnd w:id=\"1\"/>"));
        assert_eq!(out.matches("<w:commentReference ").count(), 2);
    }

    #[test]
    fn omitted_content_gets_a_point_anchor_without_touching_previous_paragraphs() {
        let mut comments = DocxComments::new(&[(3, "<note>".into())], 3).unwrap();
        let mut out = "<w:p><w:r><w:t>Previous</w:t></w:r></w:p>".to_string();
        let before = out.clone();
        let from = out.len();
        comments.attach(3, 3, &mut out, from);
        assert!(out.starts_with(&before));
        assert!(out[from..].starts_with("<w:p><w:commentRangeStart"));
        assert!(comments.xml().contains("&lt;note&gt;"));
        assert!(DocxComments::new(&[(0, "bad".into())], 3).is_err());
        assert!(DocxComments::new(&[(4, "bad".into())], 3).is_err());
    }
}
