// 통합 확인: 샘플 마크다운 → DOCX 생성.
fn main() {
    let md = r#"# IYAGI Markdown 테스트

**굵게**, *기울임*, `code`. [링크](https://example.com)

- 항목 A
- 항목 B
  - 중첩

1. 첫째
2. 둘째

> 인용문입니다.

| 이름 | 값 |
|:-----|---:|
| a    | 1  |

```rust
fn main() { println!("hi"); }
```

$$x^2 + \frac{1}{2}$$

인라인 $a+b$ 수식.
"#;
    let mut math = std::collections::HashMap::new();
    math.insert("x^2 + \\frac{1}{2}".to_string(),
        "<math xmlns=\"http://www.w3.org/1998/Math/MathML\" display=\"block\"><mrow><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mfrac><mn>1</mn><mn>2</mn></mfrac></mrow></math>".to_string());
    math.insert("a+b".to_string(),
        "<math xmlns=\"http://www.w3.org/1998/Math/MathML\"><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow></math>".to_string());
    let diagrams = std::collections::HashMap::new();
    let images = md_export::ImageSource::new(String::new());
    md_export::docx::export_docx(
        md,
        &math,
        &diagrams,
        &images,
        std::path::Path::new("/tmp/iyagi-e2e.docx"),
        Some(("serif", 12.0)),
    )
    .unwrap();
    println!("DOCX 생성 완료");
}
