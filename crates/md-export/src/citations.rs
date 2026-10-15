//! 인용·서지 전처리(Word References의 마크다운 판) — comrak 파싱 전 단계.
//!
//! 문법(프런트 citations.ts와 동일 의미론):
//!   본문: `[@key]` · `[@key, p. 12]`  → 첫 등장 순 번호 [N]
//!   서지: `[@key]: 항목`(한 줄 정의)
//!
//! comrak이 `[@key]:` 를 링크 참조 정의로 소비하므로(각주와 같은 함정)
//! 파싱 전에 치환한다:
//!   - 인라인 인용 → 센티넬 `\u{E001}key\u{E003}접미사\u{E001}`(해석은 docx.rs)
//!   - 정의 줄     → `[N] 항목` 일반 문단(줄 위치 불변 — 북마크 앵커용)

use std::collections::HashMap;

const OPEN: char = '\u{E001}';
const SEP: char = '\u{E003}';

#[derive(Default)]
pub struct Citations {
    /// 치환된 마크다운(줄 수 불변).
    pub md: String,
    /// 정의 순서(키, 항목).
    pub defs: Vec<(String, String)>,
    /// 정의 줄 번호(1 기준) → 키(문단 북마크용).
    pub lines: HashMap<u32, String>,
    /// 인용된 키 → 번호(1 기준, 첫 등장 순).
    pub nums: HashMap<String, usize>,
}

fn is_fence(line: &str) -> bool {
    let t = line.trim_start();
    let c = match t.chars().next() {
        Some(c @ ('`' | '~')) => c,
        _ => return false,
    };
    t.len() >= 3 && t.chars().all(|x| x == c)
}

/// 한 줄이 서지 정의인가 — `(키, 항목)`.
fn parse_def(line: &str) -> Option<(String, String)> {
    let t = line.trim_start();
    let rest = t.strip_prefix("[@")?;
    let close = rest.find(']')?;
    let key = &rest[..close];
    let after = &rest[close + 1..];
    if key.is_empty() || key.contains(char::is_whitespace) || key.contains('[') {
        return None;
    }
    let entry = after.strip_prefix(':')?.trim_start().to_string();
    Some((key.to_string(), entry))
}

/// 인라인 인용 치환 — `[@key]`(·접미사) → 센티넬. 유효하지 않으면 원문 유지.
fn replace_inline(line: &str, out: &mut String) {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        let rest = &line[i..];
        if let Some(start) = rest.find("[@") {
            let abs = i + start;
            let after = &line[abs + 2..];
            if let Some(close) = after.find(']') {
                let inner = &after[..close];
                let (key, suffix) = match inner.find(',') {
                    Some(c) => (inner[..c].trim(), Some(inner[c + 1..].trim().to_string())),
                    None => (inner.trim(), None),
                };
                if !key.is_empty() && !key.contains(char::is_whitespace) && !key.contains('[') {
                    out.push_str(&line[i..abs]);
                    out.push(OPEN);
                    out.push_str(key);
                    out.push(SEP);
                    if let Some(s) = &suffix {
                        out.push_str(s);
                    }
                    out.push(OPEN);
                    i = abs + 2 + close + 1;
                    continue;
                }
            }
            out.push_str(&line[i..abs + 2]);
            i = abs + 2;
        } else {
            out.push_str(rest);
            break;
        }
    }
}

impl Citations {
    /// 마크다운 전체를 스캔해 번호를 매기고 치환한다.
    pub fn extract(markdown: &str) -> Citations {
        // 1차: 정의 수집 + 본문 인용 첫 등장 순서(정의 줄·펜스 제외).
        let mut defs: Vec<(String, String)> = Vec::new();
        let mut lines: HashMap<u32, String> = HashMap::new();
        let mut order: Vec<String> = Vec::new();
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut in_fence = false;
        for (idx, line) in markdown.lines().enumerate() {
            if is_fence(line) {
                in_fence = !in_fence;
                continue;
            }
            if in_fence {
                continue;
            }
            if let Some((key, entry)) = parse_def(line) {
                lines.insert(idx as u32 + 1, key.clone());
                defs.push((key, entry));
                continue;
            }
            first_appearances(line, &mut seen, &mut order);
        }
        let mut nums: HashMap<String, usize> = HashMap::new();
        let mut n = 0;
        for k in &order {
            if defs.iter().any(|(d, _)| d == k) {
                n += 1;
                nums.insert(k.clone(), n);
            }
        }
        // 2차: 줄 재구성 — 정의는 [N] 항목, 본문은 센티넬.
        let mut md = String::with_capacity(markdown.len());
        let mut in_fence = false;
        for (idx, line) in markdown.lines().enumerate() {
            if idx > 0 {
                md.push('\n');
            }
            if is_fence(line) {
                in_fence = !in_fence;
                md.push_str(line);
                continue;
            }
            if in_fence {
                md.push_str(line);
                continue;
            }
            if let Some(key) = lines.get(&(idx as u32 + 1)) {
                let entry = defs
                    .iter()
                    .find(|(d, _)| d == key)
                    .map(|(_, e)| e.as_str())
                    .unwrap_or("");
                match nums.get(key) {
                    Some(n) => md.push_str(&format!("[{n}] {entry}")),
                    None => md.push_str(entry),
                }
                continue;
            }
            let mut out = String::with_capacity(line.len());
            replace_inline(line, &mut out);
            md.push_str(&out);
        }
        Citations {
            md,
            defs,
            lines,
            nums,
        }
    }
}

/// 줄 안 인용 키들의 첫 등장 기록.
fn first_appearances(
    line: &str,
    seen: &mut std::collections::HashSet<String>,
    order: &mut Vec<String>,
) {
    let mut i = 0;
    while i < line.len() {
        let rest = &line[i..];
        match rest.find("[@") {
            Some(start) => {
                let after = &line[i + start + 2..];
                match after.find(']') {
                    Some(close) => {
                        let inner = &after[..close];
                        let key = match inner.find(',') {
                            Some(c) => &inner[..c],
                            None => inner,
                        }
                        .trim();
                        if !key.is_empty()
                            && !key.contains(char::is_whitespace)
                            && !key.contains('[')
                            && seen.insert(key.to_string())
                        {
                            order.push(key.to_string());
                        }
                        i = i + start + 2 + close + 1;
                    }
                    None => break,
                }
            }
            None => break,
        }
    }
}

/// 센티넬 해석용 — docx.rs에서 쓰는 구분자 상수 재노출.
pub const CITATION_OPEN: char = OPEN;
pub const CITATION_SEP: char = SEP;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbering_and_substitution() {
        let md = "연구 [@kim2020]와 [@lee2021, p. 12].\n\n[@kim2020]: Kim (2020).\n[@lee2021]: Lee (2021).";
        let c = Citations::extract(md);
        assert_eq!(c.nums.get("kim2020"), Some(&1));
        assert_eq!(c.nums.get("lee2021"), Some(&2));
        assert!(c.md.contains("[1] Kim (2020)."));
        assert!(c.md.contains(&format!("연구 {OPEN}kim2020{SEP}{OPEN}와")));
        assert!(c.md.contains(&format!("{OPEN}lee2021{SEP}p. 12{OPEN}.")));
    }

    #[test]
    fn fence_excluded_and_uncited_unnumbered() {
        let md = "```\n[@f]: 펜스\n```\n\n[@f]: F.\n[@uncited]: U.";
        let c = Citations::extract(md);
        assert_eq!(c.lines.len(), 2); // 펜스 안 정의는 제외
        assert!(c.md.contains("[@f]: 펜스")); // 펜스 안은 원문
        assert!(!c.nums.contains_key("f")); // 본문 인용 없음 → 번호 없음
        assert!(c.md.contains("F."));
        assert!(c.md.contains("U."));
        assert!(!c.md.contains("[1]"));
    }

    #[test]
    fn unknown_key_kept_literal_by_extractor() {
        // 정의 없는 키도 센티널로(해석 단계에서 원문 복원).
        let c = Citations::extract("끊긴 [@ghost] 인용.");
        assert!(c.md.contains(&format!("{OPEN}ghost{SEP}{OPEN}")));
    }
}
