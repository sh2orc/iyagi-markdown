//! OOXML 조각용 XML 이스케이프·작은 빌더.

/// 텍스트 노드·속성값에 넣을 수 있게 이스케이프.
pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0이 허용하지 않는 제어 문자는 U+FFFD로 대체(Word 호환).
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {
                out.push('\u{FFFD}')
            }
            c => out.push(c),
        }
    }
    out
}

/// xml:space="preserve"가 필요한 텍스트(코드 등)의 공백 보존 속성.
pub const PRESERVE: &str = " xml:space=\"preserve\"";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_markup() {
        assert_eq!(esc(r#"<a & "b">"#), "&lt;a &amp; &quot;b&quot;&gt;");
    }

    #[test]
    fn control_chars_replaced() {
        assert_eq!(esc("a\u{0}b"), "a\u{FFFD}b");
        assert_eq!(esc("a\tb\nc"), "a\tb\nc");
    }
}
