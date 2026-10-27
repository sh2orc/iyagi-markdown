// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { epubChapterInputs, firstEpubLocalImage, h2Sections, splitEpubChapters, toXhtml } from "./epub";
import { renderExportBody } from "./html";

function parseXhtml(body: string): Document {
  const doc = new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>${body}</body></html>`,
    "application/xhtml+xml",
  );
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

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

  it("keeps nested headings, comments and heading-like attributes in their containers", () => {
    const body = `<h1 id="a">A</h1>
<blockquote><h1 id="quoted">Quoted</h1><p>same quote</p></blockquote>
<ul><li><h1>List</h1><p>same item</p></li></ul>
<!-- <h1>comment</h1> --><p title="<h1>attribute">text</p>
<h1 id="b">B</h1>`;
    const chapters = epubChapterInputs(splitEpubChapters(body));
    expect(chapters).toHaveLength(2);
    const first = parseXhtml(chapters[0].body);
    expect(first.querySelector("blockquote h1")?.textContent).toBe("Quoted");
    expect(first.querySelector("blockquote p")?.textContent).toBe("same quote");
    expect(first.querySelector("li p")?.textContent).toBe("same item");
    expect(first.querySelector("p[title]")?.getAttribute("title")).toBe("<h1>attribute");
    expect(parseXhtml(chapters[1].body).querySelector("h1")?.id).toBe("b");
  });

  it("decodes entities in navigation titles and accepts single-quoted section IDs", () => {
    const chapters = splitEpubChapters("<h1>A &amp; B <em>&lt;C&gt;</em></h1><h2 id='a&amp;b'>X &amp; Y</h2>");
    expect(chapters[0].title).toBe("A & B <C>");
    expect(chapters[0].sections).toEqual([{ anchor: "a&b", title: "X & Y" }]);
    expect(h2Sections("<h2 data-id='wrong' id='right'>T</h2>"))
      .toEqual([{ anchor: "right", title: "T" }]);
  });
});

describe("toXhtml / epubChapterInputs", () => {
  it("chooses a decoded local cover from rendered images, excluding code and remote sources", async () => {
    const body = await renderExportBody(
      '```\n![fake](missing.png)\n```\n\n![remote](https://example.org/pic.png)\n\n![cover][image]\n\n[image]: <assets/a & 한글.png>\n',
      { title: "T", baseDir: "/docs", theme: "light", inlineImages: false },
    );
    expect(firstEpubLocalImage(body, "/docs")).toBe("/docs/assets/a & 한글.png");
    expect(firstEpubLocalImage('<img src="//example.org/a.png"><img src="data:image/png;base64,AAAA">', "/docs")).toBeNull();
    expect(firstEpubLocalImage('<img src="../assets/a%23b.svg#view">', "/docs/sub")).toBe("/docs/assets/a#b.svg");
  });

  it("빈 요소 자가 폐쇄, 이미 닫힌 건 그대로", () => {
    const doc = parseXhtml(toXhtml("a<br>b<hr>c<img src=\"x\">"));
    expect(doc.querySelectorAll("br,hr,img")).toHaveLength(3);
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("x");
    expect(parseXhtml(toXhtml("<br/>")).querySelectorAll("br")).toHaveLength(1);
  });

  it("챕터 입력 조립(파일 이름·XHTML화)", () => {
    const inputs = epubChapterInputs([{ title: "T", body: "<p>x</p><br>", sections: [] }]);
    expect(inputs[0].file).toBe("chapter1.xhtml");
    expect(parseXhtml(inputs[0].body).querySelectorAll("br")).toHaveLength(1);
  });

  it("serializes named entities, boolean attributes, all void elements and foreign namespaces", () => {
    const doc = parseXhtml(toXhtml(`<p title="a &amp; b">A&nbsp;&copy;</p>
<input type="checkbox" checked disabled><table><colgroup><col></colgroup><tbody><tr><td>T</td></tr></tbody></table>
<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>
<math><mi>x</mi></math>`));
    expect(doc.querySelector("p")?.textContent).toBe("A\u00a0©");
    expect(doc.querySelector("p")?.getAttribute("title")).toBe("a & b");
    expect(doc.querySelector("input")?.hasAttribute("checked")).toBe(true);
    expect(doc.querySelector("col")).not.toBeNull();
    expect(doc.querySelector("svg")?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(doc.querySelector("mi")?.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
  });

  it("rewrites cross-chapter links in both directions while preserving other targets", () => {
    const chapters = epubChapterInputs(splitEpubChapters(`
<h1 id="a">A</h1><a href="#%EC%84%A4%EC%B9%98">next</a><a href="#a">same</a>
<a href="#missing">missing</a><a href="other.md#a">file</a><a href="https://example.org/#a">web</a>
<h1 id="설치">B</h1><a href="#a">previous</a><a href="#">top</a>`));
    const hrefs = chapters.map((chapter) =>
      [...parseXhtml(chapter.body).querySelectorAll("a")].map((link) => link.getAttribute("href")));
    expect(hrefs).toEqual([
      ["chapter2.xhtml#%EC%84%A4%EC%B9%98", "#a", "#missing", "other.md#a", "https://example.org/#a"],
      ["chapter1.xhtml#a", "chapter1.xhtml"],
    ]);
  });

  it("keeps rendered footnote links and backlinks valid after chapter splitting", async () => {
    const markdown = "# First\n\nText[^note]. [Next](#second)\n\n# Second\n\nMore[^note].\n\n[^note]: Shared note.\n";
    const body = await renderExportBody(markdown, { title: "T", baseDir: "", theme: "light", inlineImages: false });
    const chapters = epubChapterInputs(splitEpubChapters(body));
    expect(chapters).toHaveLength(2);
    const docs = new Map(chapters.map((chapter) => [chapter.file, parseXhtml(chapter.body)]));
    let links = 0;
    for (const chapter of chapters) {
      for (const link of docs.get(chapter.file)!.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href")!;
        if (!href.includes("#")) continue;
        const [file, fragment] = href.split("#");
        const target = docs.get(file || chapter.file);
        expect(target, `missing chapter for ${href}`).toBeDefined();
        expect(target!.getElementById(decodeURIComponent(fragment)), `missing anchor for ${href}`).not.toBeNull();
        links += 1;
      }
    }
    expect(links).toBeGreaterThanOrEqual(5);
    expect(chapters[0].body).toContain("chapter2.xhtml#fn1");
    expect(chapters[1].body).toContain("chapter1.xhtml#fnref1");
  });

  it("uses the shared export sanitization and preserves local image paths for packaging", async () => {
    const body = await renderExportBody(
      '# Chapter\n\n<img src="assets/a.png" onerror="alert(1)">\n\n<script>alert(1)</script>\n',
      { title: "T", baseDir: "", theme: "light", inlineImages: false, imageWidths: { "assets/a.png": 50 } },
    );
    const [chapter] = epubChapterInputs(splitEpubChapters(body));
    const doc = parseXhtml(chapter.body);
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(doc.querySelector("img")?.getAttribute("src")).toBe("assets/a.png");
    expect(doc.querySelector("img")?.getAttribute("style")).toContain("50%");
  });
});
