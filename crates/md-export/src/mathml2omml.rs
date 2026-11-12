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
    // KaTeX는 `<span class="katex"><math>…</math></span>`으로 감싸 준다 — 루트가
    // 아니라 첫 math 요소를 찾는다(루트만 보면 모든 수식이 LaTeX 원문으로 떨어진다).
    let root = doc
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == "math")
        .ok_or(MathError::NoRoot)?;
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
    let kids = children_of(node);
    let mut out = String::new();
    let mut i = 0;
    while i < kids.len() {
        // 극한 달린 큰 연산자(∑ ∏ ∫ …)는 바로 뒤 항을 피연산자로 품는다 — 비워 두면
        // Word가 빈 자리 상자를 그리고 피연산자는 연산자 밖에 놓인다.
        if let Some(head) = nary_head(kids[i])? {
            let operand = match kids.get(i + 1) {
                Some(next) => {
                    i += 1;
                    convert(*next)?
                }
                None => String::new(),
            };
            out.push_str(&format!("{head}<m:e>{operand}</m:e></m:nary>"));
        } else {
            out.push_str(&convert(kids[i])?);
        }
        i += 1;
    }
    Ok(out)
}

/// 큰 연산자에 극한이 붙은 요소면 `<m:nary>`의 여는 부분(피연산자 직전까지).
fn nary_head(node: Node<'_, '_>) -> Result<Option<String>, MathError> {
    let tag = node.tag_name().name();
    let (stacked, has_sub, has_sup) = match tag {
        "munderover" => (true, true, true),
        "munder" => (true, true, false),
        "mover" => (true, false, true),
        "msubsup" => (false, true, true),
        "msub" => (false, true, false),
        "msup" => (false, false, true),
        _ => return Ok(None),
    };
    let children = children_of(node);
    let Some(base) = children.first() else {
        return Ok(None);
    };
    let base_text = collapse_text(*base);
    let mut chars = base_text.chars();
    let (Some(chr), None) = (chars.next(), chars.next()) else {
        return Ok(None);
    };
    if !is_big_operator(chr) {
        return Ok(None);
    }
    let part = |present: bool, index: usize| -> Result<String, MathError> {
        match children.get(index).filter(|_| present) {
            Some(child) => convert(*child),
            None => Ok(String::new()),
        }
    };
    let sub = part(has_sub, 1)?;
    let sup = part(has_sup, if has_sub { 2 } else { 1 })?;
    Ok(Some(format!(
        "<m:nary><m:naryPr><m:chr m:val=\"{}\"/><m:limLoc m:val=\"{}\"/>\
<m:subHide m:val=\"{}\"/><m:supHide m:val=\"{}\"/></m:naryPr>\
<m:sub>{sub}</m:sub><m:sup>{sup}</m:sup>",
        esc(&chr.to_string()),
        if stacked { "undOvr" } else { "subSup" },
        u8::from(!has_sub),
        u8::from(!has_sup),
    )))
}

/// 텍스트 실행(m:r) — 수식 기본 서식(한 글자 변수는 기울임).
fn run(text: &str) -> String {
    styled_run(text, "")
}

/// 서식 속성(m:rPr 안쪽)을 붙인 텍스트 실행.
fn styled_run(text: &str, math_props: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let props = if math_props.is_empty() {
        String::new()
    } else {
        format!("<m:rPr>{math_props}</m:rPr>")
    };
    format!(
        "<m:r>{props}<w:rPr><w:rFonts w:ascii=\"Cambria Math\" w:hAnsi=\"Cambria Math\"/></w:rPr>\
<m:t xml:space=\"preserve\">{}</m:t></m:r>",
        esc(text)
    )
}

/// MathML mathvariant → OMML 글꼴 속성(m:scr 글꼴 계열 + m:sty 굵기·기울임).
/// KaTeX는 `\mathbb{R}`·`\mathbf{v}`를 유니코드로 바꾸지 않고 속성으로만 남긴다.
fn variant_props(variant: &str) -> &'static str {
    match variant {
        "normal" => "<m:sty m:val=\"p\"/>",
        "bold" => "<m:sty m:val=\"b\"/>",
        "italic" => "<m:sty m:val=\"i\"/>",
        "bold-italic" => "<m:sty m:val=\"bi\"/>",
        "double-struck" => "<m:scr m:val=\"double-struck\"/><m:sty m:val=\"p\"/>",
        "script" => "<m:scr m:val=\"script\"/><m:sty m:val=\"p\"/>",
        "bold-script" => "<m:scr m:val=\"script\"/><m:sty m:val=\"b\"/>",
        "fraktur" => "<m:scr m:val=\"fraktur\"/><m:sty m:val=\"p\"/>",
        "bold-fraktur" => "<m:scr m:val=\"fraktur\"/><m:sty m:val=\"b\"/>",
        "sans-serif" => "<m:scr m:val=\"sans-serif\"/><m:sty m:val=\"p\"/>",
        "bold-sans-serif" => "<m:scr m:val=\"sans-serif\"/><m:sty m:val=\"b\"/>",
        "sans-serif-italic" => "<m:scr m:val=\"sans-serif\"/><m:sty m:val=\"i\"/>",
        "sans-serif-bold-italic" => "<m:scr m:val=\"sans-serif\"/><m:sty m:val=\"bi\"/>",
        "monospace" => "<m:scr m:val=\"monospace\"/><m:sty m:val=\"p\"/>",
        _ => "",
    }
}

fn convert(node: Node<'_, '_>) -> Result<String, MathError> {
    let tag = node.tag_name().name();
    let children = children_of(node);
    let text = node.text().unwrap_or("").trim();

    match tag {
        "math" | "mrow" | "semantics" | "annotation-xml" => convert_children(node),

        "mi" | "mn" | "mo" | "ms" => {
            let content = collapse_text(node);
            let props = match node.attribute("mathvariant") {
                Some(variant) => variant_props(variant),
                // MathML 기본값: 여러 글자 식별자(sin, log …)는 곧은 글꼴.
                None if tag == "mi" && content.chars().count() > 1 => "<m:sty m:val=\"p\"/>",
                None => "",
            };
            Ok(styled_run(&content, props))
        }
        // 글(\text{…})은 곧은 글꼴로, 앞뒤 공백(KaTeX는 NBSP로 준다)을 살려서 —
        // 공백을 접으면 "x if y"가 "xify"로 붙는다.
        "mtext" => {
            let mut content = String::new();
            collect_text(node, &mut content);
            let props = match node.attribute("mathvariant") {
                Some(variant) if !variant_props(variant).is_empty() => variant_props(variant),
                _ => "<m:sty m:val=\"p\"/>",
            };
            Ok(styled_run(&content.replace('\u{a0}', " "), props))
        }

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

        // \boxed → 테두리 상자. 그 밖의 표기(취소선 등)는 내용만 남긴다.
        "menclose" => {
            let inner = convert_children(node)?;
            if node
                .attribute("notation")
                .is_some_and(|notation| notation.split_whitespace().any(|n| n == "box"))
            {
                Ok(format!("<m:borderBox><m:e>{inner}</m:e></m:borderBox>"))
            } else {
                Ok(inner)
            }
        }

        // 지원 밖: 내용만 편집 가능한 수식으로 남긴다(태그 이름을 글자로 찍지 않는다).
        _ => {
            let _ = text;
            convert_children(node)
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

    /// 실제 KaTeX 0.19 `renderToString(…, {output: "mathml"})` 출력 모양.
    fn katex(inner: &str) -> String {
        format!(
            "<span class=\"katex\"><math xmlns=\"{MATH_NS}\" display=\"block\"><semantics><mrow>{inner}</mrow>\
<annotation encoding=\"application/x-tex\">src</annotation></semantics></math></span>"
        )
    }

    #[test]
    fn real_katex_wrapper_is_converted() {
        let out = mathml_to_omml(&katex(
            "<mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup>",
        ))
        .unwrap();
        assert!(out.starts_with("<m:oMath>"));
        assert!(out.contains("<m:sSup>"));
        assert!(!out.contains("src"));
    }

    #[test]
    fn variants_text_boxes_and_operands_survive() {
        let out = mathml_to_omml(&katex("<mi mathvariant=\"double-struck\">R</mi>")).unwrap();
        assert!(out.contains("<m:scr m:val=\"double-struck\"/>"), "{out}");
        let out = mathml_to_omml(&katex("<mi mathvariant=\"bold\">v</mi>")).unwrap();
        assert!(out.contains("<m:sty m:val=\"b\"/>"), "{out}");

        let out =
            mathml_to_omml(&katex("<mi>x</mi><mtext>\u{a0}if\u{a0}</mtext><mi>y</mi>")).unwrap();
        assert!(out.contains(">\u{20}if\u{20}<"), "글 앞뒤 공백 유지: {out}");
        let out = mathml_to_omml(&katex("<mi>a</mi><mtext>\u{a0}</mtext><mi>b</mi>")).unwrap();
        assert_eq!(
            out.matches("<m:r>").count(),
            3,
            "공백만 있는 글도 남는다: {out}"
        );

        let out = mathml_to_omml(&katex(
            "<menclose notation=\"box\"><mstyle><mi>a</mi></mstyle></menclose>",
        ))
        .unwrap();
        assert!(
            out.contains("<m:borderBox><m:e>") && !out.contains("menclose"),
            "{out}"
        );

        let out = mathml_to_omml(&katex(
            "<munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover>\
<msub><mi>a</mi><mi>i</mi></msub>",
        ))
        .unwrap();
        let operand = &out[out.find("</m:sup><m:e>").expect("피연산자 자리")..];
        assert!(operand.contains("<m:sSub>"), "합의 항이 nary 안에: {out}");

        let out = mathml_to_omml(&katex(
            "<msubsup><mo>∫</mo><mn>0</mn><mn>1</mn></msubsup><mi>f</mi>",
        ))
        .unwrap();
        assert!(out.contains("<m:limLoc m:val=\"subSup\"/>"), "{out}");
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
