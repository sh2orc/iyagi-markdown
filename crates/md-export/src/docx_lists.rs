//! Native Word list instances. A Markdown List node owns its numbering sequence;
//! separate lists (including footnote lists) must not continue one another.

use std::fmt::Write as _;

use comrak::nodes::{ListDelimType, ListType, NodeList};

#[derive(Clone, Copy)]
pub(crate) struct ListInstance {
    pub id: usize,
    pub level: usize,
    pub ordered: bool,
}

impl ListInstance {
    pub fn paragraph_properties(self, first: bool, task: bool) -> String {
        let left = (self.level + 1) * 360;
        if first && (!task || self.ordered) {
            format!("<w:numPr><w:ilvl w:val=\"{}\"/><w:numId w:val=\"{}\"/></w:numPr><w:ind w:left=\"{left}\" w:hanging=\"240\"/>", self.level, self.id)
        } else if first {
            // An unordered task uses its checkbox as the marker, without a bullet.
            format!("<w:tabs><w:tab w:val=\"left\" w:pos=\"{left}\"/></w:tabs><w:ind w:left=\"{left}\" w:hanging=\"240\"/>")
        } else {
            format!("<w:ind w:left=\"{left}\" w:firstLine=\"0\"/>")
        }
    }
}

struct Definition {
    instance: ListInstance,
    start: usize,
    abstract_id: usize,
}

#[derive(Default)]
pub(crate) struct DocxLists {
    definitions: Vec<Definition>,
}

impl DocxLists {
    pub fn add(&mut self, list: &NodeList, level: usize) -> ListInstance {
        let ordered = list.list_type == ListType::Ordered;
        let instance = ListInstance {
            id: self.definitions.len() + 1,
            level: level.min(8),
            ordered,
        };
        let abstract_id = if !ordered {
            0
        } else if list.delimiter == ListDelimType::Paren {
            2
        } else {
            1
        };
        self.definitions.push(Definition {
            instance,
            start: if ordered { list.start } else { 1 },
            abstract_id,
        });
        instance
    }

    pub fn xml(&self) -> String {
        let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:numbering xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">");
        // Every supported Word level is namespaced. Markdown ordered lists stay
        // decimal at every depth instead of changing to letters or Roman numerals.
        for abstract_id in 0..3 {
            let _ = write!(out, "<w:abstractNum w:abstractNumId=\"{abstract_id}\"><w:multiLevelType w:val=\"multilevel\"/>");
            for level in 0..9 {
                let left = (level + 1) * 360;
                let (format, label) = if abstract_id == 0 {
                    ("bullet", ["●", "○", "■"][level % 3].to_string())
                } else {
                    (
                        "decimal",
                        format!("%{}{}", level + 1, if abstract_id == 2 { ")" } else { "." }),
                    )
                };
                let _ = write!(out,
                    "<w:lvl w:ilvl=\"{level}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{format}\"/><w:suff w:val=\"tab\"/><w:lvlText w:val=\"{label}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:tabs><w:tab w:val=\"num\" w:pos=\"{left}\"/></w:tabs><w:ind w:left=\"{left}\" w:hanging=\"240\"/></w:pPr>");
                if abstract_id == 0 {
                    out.push_str("<w:rPr><w:rFonts w:ascii=\"Arial\" w:hAnsi=\"Arial\"/></w:rPr>");
                }
                out.push_str("</w:lvl>");
            }
            out.push_str("</w:abstractNum>");
        }
        for definition in &self.definitions {
            let ListInstance { id, level, .. } = definition.instance;
            let _ = write!(out,
                "<w:num w:numId=\"{id}\"><w:abstractNumId w:val=\"{}\"/><w:lvlOverride w:ilvl=\"{level}\"><w:startOverride w:val=\"{}\"/></w:lvlOverride></w:num>",
                definition.abstract_id, definition.start);
        }
        out.push_str("</w:numbering>");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_levels_are_namespaced_and_list_instances_keep_their_starts() {
        let mut lists = DocxLists::default();
        let ordered = NodeList {
            list_type: ListType::Ordered,
            start: 0,
            delimiter: ListDelimType::Paren,
            ..NodeList::default()
        };
        let first = lists.add(&ordered, 8);
        let second = lists.add(
            &NodeList {
                start: 23,
                ..ordered
            },
            99,
        );
        assert_ne!(first.id, second.id);
        let xml = lists.xml();
        let document = roxmltree::Document::parse(&xml).unwrap();
        let ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
        assert!(document
            .descendants()
            .filter(|node| node.is_element())
            .all(|node| node.tag_name().namespace() == Some(ns)));
        for definition in document
            .descendants()
            .filter(|node| node.has_tag_name((ns, "abstractNum")))
        {
            let levels: Vec<_> = definition
                .children()
                .filter(|node| node.has_tag_name((ns, "lvl")))
                .collect();
            assert_eq!(levels.len(), 9);
            for (level, node) in levels.iter().enumerate() {
                assert_eq!(
                    node.attribute((ns, "ilvl"))
                        .unwrap()
                        .parse::<usize>()
                        .unwrap(),
                    level
                );
                if definition.attribute((ns, "abstractNumId")) != Some("0") {
                    assert!(node
                        .children()
                        .any(|child| child.has_tag_name((ns, "numFmt"))
                            && child.attribute((ns, "val")) == Some("decimal")));
                }
            }
        }
        let starts: Vec<_> = document
            .descendants()
            .filter(|node| node.has_tag_name((ns, "startOverride")))
            .map(|node| node.attribute((ns, "val")).unwrap())
            .collect();
        assert_eq!(starts, ["0", "23"]);
        assert!(document
            .descendants()
            .filter(|node| node.has_tag_name((ns, "lvlOverride")))
            .all(|node| node.attribute((ns, "ilvl")) == Some("8")));
    }
}
