use md_export::citations::Citations;
#[test]
fn emphasis_citation_matrix() {
    let cases: Vec<(&str, &str)> = vec![
        // (입력 인용 부분, 기대하는 링크 막을 형태)
        ("**[@a]**와", "[**\\[1\\]**](<#ref-a> \"iyagi:citation\")와"),
        (
            "**[@a]** 끝",
            "[**\\[1\\]**](<#ref-a> \"iyagi:citation\") 끝",
        ),
        (
            "**[@a, p. 3]**.",
            "[**\\[1\\, p\\. 3\\]**](<#ref-a> \"iyagi:citation\").",
        ),
        ("*[@a]*로", "[*\\[1\\]*](<#ref-a> \"iyagi:citation\")로"),
        (
            "***[@a]***직후",
            "[***\\[1\\]***](<#ref-a> \"iyagi:citation\")직후",
        ),
        (
            "__[@a]__밑줄",
            "[__\\[1\\]__](<#ref-a> \"iyagi:citation\")밑줄",
        ),
        (
            "~~[@a]~~취소",
            "[~~\\[1\\]~~](<#ref-a> \"iyagi:citation\")취소",
        ),
        (
            "- **[@a]**항목",
            "- [**\\[1\\]**](<#ref-a> \"iyagi:citation\")항목",
        ),
        ("**[@a]**", "[**\\[1\\]**](<#ref-a> \"iyagi:citation\")"),
    ];
    for (input, expected) in cases {
        let md = format!("{input}\n\n[@a]: A.\n");
        let out = Citations::extract(&md).md;
        assert!(
            out.contains(expected),
            "case {input:?}\n  got: {out:?}\n  want substring: {expected:?}"
        );
    }
    // CRLF — 줄 끝 \r 이 닫는 런 뒤에 와도 정상 동작.
    let crlf = Citations::extract("**[@a]**와\r\n\r\n[@a]: A.\r\n").md;
    assert!(crlf.contains("[**\\[1\\]**](<#ref-a> \"iyagi:citation\")와"));
    // 정의 없는 인용은 손대지 않는다.
    let ghost = Citations::extract("**[@ghost]**와").md;
    assert_eq!(ghost, "**[@ghost]**와");
    // 백틱/링크 안은 보호(기존 규약 회귀 확인).
    let code = Citations::extract("`**[@a]**` [@a]\n\n[@a]: A.\n").md;
    assert!(code.starts_with("`**[@a]**` ["));
}
