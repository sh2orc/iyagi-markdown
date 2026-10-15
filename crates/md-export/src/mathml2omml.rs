//! MathML(Presentation 부분집합) → OMML 변환기(§4-3).
//!
//! KaTeX `output:'mathml'` 결과를 Word 수식(m:oMath)으로 옮긴다. Microsoft의
//! MML2OMML 매핑 규칙을 참고해 Presentation MathML 부분집합을 구현한다:
//! math mrow mi mn mo mtext ms mspace mfrac msup msub msubsup msqrt mroot
//! munder mover munderover mtable mtr mtd mfenced mstyle mpadded mphantom.
//!
//! 지원 밖 구조는 OMML 텍스트 실행(m:r)로 넣어 **여전히 수식 객체 안에서 편집
//! 가능**하게 둔다 — 이미지 폴백은 없다(§4-3).

use roxmltree::Node;

use crate::xml::esc;

#[derive(Debug, thiserror::Error)]
pub enum MathError {
    #[error("MathML을 해석하지 못했습니다: {0}")]
    Parse(#[from] roxmltree::Error),
    #[error("수식 루트(math)가 없습니다")]
    NoRoot,
}

/// MathML 문자열 → m:oMath XML 조각.
pub fn mathml_to_omml(mathml: &str) -> Result<String, MathError> {
    let doc = roxmltree::Document::parse(mathml)?;
    let root = doc.root_element();
    if root.tag_name().name() != "math" {
        return Err(MathError::NoRoot);
    }
    let inner = convert_children(root)?;
    Ok(format!("<m:oMath>{inner}</m:oMath>"))
}

fn is_math(node: Node) -> bool {
    node.tag_name()
        .namespace()
        .map(|ns| ns.contains("MathML"))
        .unwrap_or(false)
        || node.tag_name().namespace().is_none()
}

fn children_of<'a, 'input>(node: Node<'a, 'input>) -> Vec<Node<'a, 'input>> {
    node.children()
        .filter(|c| c.is_element() && is_math(*c) && c.tag_name().name() != "annotation")
        .collect()
}

fn convert_children(node: Node<'_, '_>) -> Result<String, MathError> {
    let mut out = String::new();
    for c in children_of(node) {
        out.push_str(&convert(c)?);
    }
    Ok(out)
}

/// 텍스트 실행(m:r). KaTeX는 이미 유니코드 수식 문자로 스타일을 입혀 둔다.
fn run(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    format!(
        "<m:r><w:rPr><w:rFonts w:ascii=\"Cambria Math\" w:hAnsi=\"Cambria Math\"/></w:rPr>\
<m:t xml:space=\"preserve\">{}</m:t></m:r>",
        esc(text)
    )
}

fn convert(node: Node<'_, '_>) -> Result<String, MathError> {
    let tag = node.tag_name().name();
    let children = children_of(node);
    let text = node.text().unwrap_or("").trim();

    match tag {
        "math" | "mrow" | "semantics" | "annotation-xml" => convert_children(node),

        "mi" | "mn" | "mo" | "mtext" | "ms" => Ok(run(&collapse_text(node))),

        "mspace" => {
            // 폭 정보는 버리고 얇은 공백 하나(편집 가능 텍스트로 유지).
            Ok(run("\u{2009}"))
        }

        "mfrac" => {
            let num = children
                .first()
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let den = children
                .get(1)
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            Ok(format!(
                "<m:f><m:num>{num}</m:num><m:den>{den}</m:den></m:f>"
            ))
        }

        "msup" => {
            let base = children
                .first()
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let sup = children
                .get(1)
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            Ok(format!(
                "<m:sSup><m:e>{base}</m:e><m:sup>{sup}</m:sup></m:sSup>"
            ))
        }
        "msub" => {
            let base = children
                .first()
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let sub = children
                .get(1)
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            Ok(format!(
                "<m:sSub><m:e>{base}</m:e><m:sub>{sub}</m:sub></m:sSub>"
            ))
        }
        "msubsup" => {
            let base = children
                .first()
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let sub = children
                .get(1)
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let sup = children
                .get(2)
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            Ok(format!(
                "<m:sSubSup><m:e>{base}</m:e><m:sub>{sub}</m:sub><m:sup>{sup}</m:sup></m:sSubSup>"
            ))
        }

        "msqrt" => Ok(format!(
            "<m:rad><m:radPr><m:degHide m:val=\"1\"/></m:radPr><m:deg/>\
<m:e>{}</m:e></m:rad>",
            convert_children(node)?
        )),
        "mroot" => {
            let base = children
                .first()
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let deg = children
                .get(1)
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            Ok(format!(
                "<m:rad><m:deg>{deg}</m:deg><m:e>{base}</m:e></m:rad>"
            ))
        }

        "munder" => {
            let base = children
                .first()
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let under = children
                .get(1)
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            // 밑줄·중괄호 계열 → m:bar / m:groupChr, 나머지 → 극한(아래).
            let under_text = children
                .get(1)
                .map(|c| collapse_text(*c))
                .unwrap_or_default();
            if under_text.chars().all(|c| "＿_⎯⏟⏞︶⏜{}︸︷".contains(c)) && !under_text.is_empty()
            {
                return Ok(format!(
                    "<m:groupChr><m:groupChrPr><m:chr m:val=\"{chr}\"/><m:pos m:val=\"bot\"/></m:groupChrPr>\
<m:e>{base}{under_runs}</m:e></m:groupChr>",
                    chr = esc(&under_text.chars().last().unwrap().to_string()),
                    under_runs = String::new(),
                ));
            }
            Ok(format!(
                "<m:limLow><m:e>{base}</m:e><m:lim>{under}</m:lim></m:limLow>"
            ))
        }

        "mover" => {
            let base = children
                .first()
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let over = children
                .get(1)
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let over_text = children
                .get(1)
                .map(|c| collapse_text(*c))
                .unwrap_or_default();
            let first = over_text.chars().next().unwrap_or(' ');
            // 조합 발음 기호·화살표 계열 → 악센트.
            if over_text.chars().count() == 1 && is_accent(first) {
                return Ok(format!(
                    "<m:acc><m:accPr><m:chr m:val=\"{}\"/></m:accPr><m:e>{base}</m:e></m:acc>",
                    esc(&first.to_string())
                ));
            }
            if over_text.chars().all(|c| "¯‾⏞⏜⏛—".contains(c)) && !over_text.is_empty() {
                return Ok(format!(
                    "<m:bar><m:barPr><m:pos m:val=\"top\"/></m:barPr><m:e>{base}</m:e></m:bar>"
                ));
            }
            Ok(format!(
                "<m:limUpp><m:e>{base}</m:e><m:lim>{over}</m:lim></m:limUpp>"
            ))
        }

        "munderover" => {
            let base = children
                .first()
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let under = children
                .get(1)
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            let over = children
                .get(2)
                .map(|c| convert(*c))
                .transpose()?
                .unwrap_or_default();
            // 큰 연산자(∑ ∏ ∫ …)면 m:nary로 정확히 표현.
            let base_text = children
                .first()
                .map(|c| collapse_text(*c))
                .unwrap_or_default();
            if base_text.chars().count() == 1 && is_big_operator(base_text.chars().next().unwrap())
            {
                return Ok(format!(
                    "<m:nary><m:naryPr><m:chr m:val=\"{}\"/><m:limLoc m:val=\"undOvr\"/>\
<m:subHide m:val=\"0\"/><m:supHide m:val=\"0\"/></m:naryPr>\
<m:sub>{under}</m:sub><m:sup>{over}</m:sup><m:e/></m:nary>",
                    esc(&base_text)
                ));
            }
            // 일반: 아래극한 안에 위극한을 겹친다(드물고 편집 가능).
            Ok(format!(
                "<m:limLow><m:e><m:limUpp><m:e>{base}</m:e><m:lim>{over}</m:lim></m:limUpp></m:e>\
<m:lim>{under}</m:lim></m:limLow>"
            ))
        }

        "mtable" => {
            let mut rows = String::new();
            for child in &children {
                if child.tag_name().name() == "mtr" {
                    let mut cells = String::new();
                    for cell in children_of(*child) {
                        let inner = convert(cell).unwrap_or_default();
                        cells.push_str(&format!("<m:e>{inner}</m:e>"));
                    }
                    rows.push_str(&format!("<m:mr>{cells}</m:mr>"));
                }
            }
            Ok(format!(
                "<m:m><m:mPr><m:mcs><m:mc><m:mcPr><m:count m:val=\"1\"/>\
<m:mcJc m:val=\"center\"/></m:mcPr></m:mc></m:mcs></m:mPr>{rows}</m:m>"
            ))
        }
        "mtr" | "mtd" => convert_children(node),

        "mfenced" => {
            let open = node.attribute("open").unwrap_or("(");
            let close = node.attribute("close").unwrap_or(")");
            let mut out = run(open);
            for (i, c) in children.iter().enumerate() {
                if i > 0 {
                    out.push_str(&run(node.attribute("separators").unwrap_or(",")));
                }
                out.push_str(&convert(*c)?);
            }
            out.push_str(&run(close));
            Ok(out)
        }

        "mstyle" | "mpadded" | "mphantom" | "merror" | "mprescripts" | "none" => {
            convert_children(node)
        }

        // 지원 밖: 원문을 그대로 텍스트 실행으로(이미지 폴백 없음, §4-3).
        _ => {
            let _ = text;
            Ok(run(&format!("<{tag}>")) + &convert_children(node)? + &run(&format!("</{tag}>")))
        }
    }
}

/// 요소 안의 모든 텍스트를 모은다(공백 정규화).
fn collapse_text(node: Node<'_, '_>) -> String {
    let mut out = String::new();
    collect_text(node, &mut out);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn collect_text(node: Node<'_, '_>, out: &mut String) {
    if node.is_text() {
        out.push_str(node.text().unwrap_or(""));
    }
    for c in node.children() {
        collect_text(c, out);
    }
}

fn is_accent(c: char) -> bool {
    matches!(
        c,
        '^' | 'ˆ'
            | '̂'
            | '̃'
            | '̄'
            | '̆'
            | '̇'
            | '̈'
            | '̌'
            | '→'
            | '←'
            | '↔'
            | '⃗'
            | '⃖'
            | '⇀'
            | '↖'
            | '↗'
            | '·'
            | '.'
            | '°'
            | '´'
            | '`'
            | '˙'
            | '⨀'
            | '⨁'
            | '⨂'
    )
}

fn is_big_operator(c: char) -> bool {
    matches!(
        c,
        '∑' | '∏'
            | '∫'
            | '∬'
            | '∭'
            | '∮'
            | '⋃'
            | '⋂'
            | '⊕'
            | '⊗'
            | '⨁'
            | '⨂'
            | '⨄'
            | '⨆'
            | '⋀'
            | '⋁'
            | '\u{2A00}'..='\u{2AFF}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MATH_NS: &str = "http://www.w3.org/1998/Math/MathML";

    fn wrap(inner: &str) -> String {
        format!("<math xmlns=\"{MATH_NS}\">{inner}</math>")
    }

    #[test]
    fn frac_sup_sub() {
        let out = mathml_to_omml(&wrap("<mfrac><mi>a</mi><mi>b</mi></mfrac>")).unwrap();
        assert!(out.contains("<m:f>"));
        assert!(out.contains("<m:num>"));
        assert!(out.contains("<m:den>"));

        let out = mathml_to_omml(&wrap("<msup><mi>x</mi><mn>2</mn></msup>")).unwrap();
        assert!(out.contains("<m:sSup>"));
        assert!(out.contains("x"));
    }

    #[test]
    fn sqrt_and_root() {
        let out = mathml_to_omml(&wrap("<msqrt><mi>x</mi></msqrt>")).unwrap();
        assert!(out.contains("<m:rad>"));
        assert!(out.contains("m:degHide"));

        let out = mathml_to_omml(&wrap("<mroot><mi>x</mi><mn>3</mn></mroot>")).unwrap();
        assert!(out.contains("<m:deg>"));
        assert!(out.contains(">3<"));
    }

    #[test]
    fn big_operator_limits_become_nary() {
        let out = mathml_to_omml(&wrap(
            "<munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover>",
        ))
        .unwrap();
        assert!(out.contains("<m:nary>"), "∑ 극한은 nary: {out}");
        assert!(out.contains("undOvr"));
    }

    #[test]
    fn accents_and_bars() {
        let out = mathml_to_omml(&wrap("<mover><mi>x</mi><mo>^</mo></mover>")).unwrap();
        assert!(out.contains("<m:acc>"));
        let out = mathml_to_omml(&wrap("<mover><mi>x</mi><mo>¯</mo></mover>")).unwrap();
        assert!(out.contains("<m:bar>"));
    }

    #[test]
    fn katex_style_output_structure() {
        // KaTeX mathml 출력의 전형적 모양.
        let mathml = r#"<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mfrac><mn>1</mn><mn>2</mn></mfrac></mrow><annotation encoding="application/x-tex">x^2+\frac12</annotation></semantics></math>"#;
        let out = mathml_to_omml(mathml).unwrap();
        assert!(out.starts_with("<m:oMath>"));
        assert!(out.contains("m:sSup"));
        assert!(out.contains("m:f"));
        // annotation XML은 남지 않는다.
        assert!(!out.contains("annotation"));
    }

    #[test]
    fn unsupported_stays_editable_text() {
        let out = mathml_to_omml(&wrap(
            "<maction actiontype=\"toggle\"><mi>a</mi><mi>b</mi></maction>",
        ))
        .unwrap();
        // 수식 객체 안의 텍스트로 떨어진다 — 래스터 아님.
        assert!(out.contains("<m:r>"));
    }

    #[test]
    fn matrix() {
        let out = mathml_to_omml(&wrap(
            "<mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>0</mn></mtd></mtr>\
<mtr><mtd><mn>0</mn></mtd><mtd><mn>1</mn></mtd></mtr></mtable>",
        ))
        .unwrap();
        assert!(out.contains("<m:m>"));
        assert_eq!(out.matches("<m:mr>").count(), 2);
        assert_eq!(out.matches("<m:e>").count(), 4);
    }
}
