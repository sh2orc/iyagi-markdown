// HTML→마크다운 붙여넣기 변환 — Word/브라우저 클립보드 서식 보존 검증.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { htmlToMarkdown } from "./htmlPaste";

describe("htmlToMarkdown(스마트 붙여넣기)", () => {
  it("굵게·기울임·취소선·인라인 코드·링크", () => {
    const md = htmlToMarkdown(
      `<p><strong>굵게</strong>와 <em>기울임</em>, <s>취소</s>, <code>x = 1</code>, <a href="https://a.b">링크</a></p>`,
    );
    expect(md).toContain("**굵게**");
    expect(md).toContain("*기울임*");
    expect(md).toContain("~~취소~~");
    expect(md).toContain("`x = 1`");
    expect(md).toContain("[링크](https://a.b)");
  });

  it("제목·목록(중첩)·인용·수평선", () => {
    const md = htmlToMarkdown(`
      <h1>제목</h1>
      <ul><li>하나<ul><li>하위</li></ul></li><li>둘</li></ul>
      <blockquote><p>인용</p></blockquote>
      <hr>
    `);
    expect(md).toContain("# 제목");
    expect(md).toContain("- 하나");
    expect(md).toContain("  - 하위");
    expect(md).toContain("> 인용");
    expect(md).toContain("---");
  });

  it("표 → GFM 표(헤더 구분 줄 생성)", () => {
    const md = htmlToMarkdown(`
      <table><tr><th>이름</th><th>값</th></tr><tr><td>a</td><td>1</td></tr></table>
    `);
    expect(md).toContain("| 이름 | 값 |");
    expect(md).toContain("|---|---|");
    expect(md).toContain("| a | 1 |");
  });

  it("코드 블록 → 펜스(언어 태그)", () => {
    const md = htmlToMarkdown(
      `<pre><code class="language-rust">fn main() {}</code></pre>`,
    );
    expect(md).toContain("```rust");
    expect(md).toContain("fn main() {}");
  });

  it("순서 목록 시작 번호 유지", () => {
    const md = htmlToMarkdown(`<ol start="3"><li>셋</li><li>넷</li></ol>`);
    expect(md).toContain("3. 셋");
    expect(md).toContain("4. 넷");
  });

  it("빈 클립보드 장식은 null", () => {
    expect(htmlToMarkdown("<style>a{}</style><p></p>")).toBeNull();
    expect(htmlToMarkdown("")).toBeNull();
  });

  it("마크다운 특수문자 이스케이프(일반 텍스트)", () => {
    const md = htmlToMarkdown(`<p>a * b [c] #d</p>`);
    expect(md).toContain("\\*");
    expect(md).toContain("\\[c\\]");
    expect(md).toContain("\\#d");
  });

  it("Word 스타일 복사(클래스·span 래퍼) 통과", () => {
    const md = htmlToMarkdown(
      `<p class="MsoNormal"><span style="color:red">빨간</span> <b>굵은</b> 텍스트</p>`,
    );
    expect(md).toContain("빨간");
    expect(md).toContain("**굵은**");
    expect(md).toContain("텍스트");
  });
});

  it("URL의 공백·괄호는 퍼센트 인코딩(CommonMark 목적지 규칙)", () => {
    const md = htmlToMarkdown(
      `<p><a href="my file (1).html">링크</a></p><p><img src="사진 2.png" alt="a"></p>`,
    );
    expect(md).toContain("(my%20file%20%281%29.html)");
    expect(md).toContain("(사진%202.png)");
    expect(md).not.toMatch(/\]\([^)]*[ ][^)]*\)/); // 목적지에 원시 공백 없음
  });
