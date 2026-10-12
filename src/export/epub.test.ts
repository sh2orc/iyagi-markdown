// EPUB 챕터 분할 테스트 — h1 경계·서문·각주 잔류·코드 블록 안 "# 제목" 무해.

import { describe, expect, it } from "vitest";

import { epubChapterInputs, splitEpubChapters, toXhtml } from "./epub";

const BODY = `<p>서문입니다.</p>
<h1 id="a">첫 장 <em>강조</em></h1>
<p>내용 A</p>
<pre><code># 코드 안 제목
</code></pre>
<h1 id="b">둘째 장</h1>
<p>내용 B</p>
<section class="footnotes"><p>각주</p></section>`;

describe("splitEpubChapters", () => {
  it("h1마다 챕터, 첫 h1 앞은 서문", () => {
    const ch = splitEpubChapters(BODY);
    expect(ch.map((c) => c.title)).toEqual(["Section 1", "첫 장 강조", "둘째 장"]);
    expect(ch[0].body).toContain("서문입니다.");
    expect(ch[1].body).toContain("내용 A");
    expect(ch[1].body).toContain("<code># 코드 안 제목");
    expect(ch[2].body).toContain("각주"); // 각주는 마지막 챕터에
  });

  it("h1이 없으면 한 챕터", () => {
    const ch = splitEpubChapters("<p>그냥 문서</p>");
    expect(ch).toHaveLength(1);
    expect(ch[0].title).toBe("");
  });
});

describe("toXhtml / epubChapterInputs", () => {
  it("빈 요소 자가 폐쇄, 이미 닫힌 건 그대로", () => {
    expect(toXhtml("a<br>b<hr>c<img src=\"x\">")).toBe("a<br/>b<hr/>c<img src=\"x\"/>");
    expect(toXhtml("<br/>")).toBe("<br/>");
  });

  it("챕터 입력 조립(파일 이름·XHTML화)", () => {
    const inputs = epubChapterInputs([{ title: "T", body: "<p>x</p><br>", sections: [] }]);
    expect(inputs[0].file).toBe("chapter1.xhtml");
    expect(inputs[0].body).toContain("<br/>");
  });
});
