// 인용·서지 HTML 내보내기 — 위첨자 링크·서지 문단·끊긴 인용 원문 보존.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { renderExportBody, renderMarkdownBody } from "./html";

const DOC = [
  "연구 [@kim2020]와 뒤이은 [@lee2021, p. 12].",
  "",
  "[@kim2020]: Kim, S. (2020). *연구*.",
  "[@lee2021]: Lee, J. (2021). 후속.",
].join("\n");

describe("인용 HTML 변환", () => {
  const opts = { title: "t", baseDir: "", theme: "light" as const };

  it("[@key] → [N] 위첨자 링크, 정의 → 서지 문단", async () => {
    const { body } = await renderMarkdownBody(DOC, opts);
    expect(body).toContain('<sup class="cite"><a href="#ref-kim2020">[1]</a></sup>');
    expect(body).toContain('<sup class="cite"><a href="#ref-lee2021">[2, p. 12]</a></sup>');
    expect(body).toContain('id="ref-kim2020"');
    expect(body).toContain("Kim, S. (2020).");
    // 정의 줄이 링크 참조로 소진되지 않았는지 — 서지 텍스트가 살아 있다.
    expect(body).toContain("Lee, J. (2021).");
  });

  it("정의 없는 인용은 원문 그대로", async () => {
    const { body } = await renderMarkdownBody("끊긴 [@ghost] 인용.", opts);
    expect(body).toContain("[@ghost]");
    expect(body).not.toContain('class="cite"');
  });

  it("강조로 감싼 인용도 뒤에 글자가 붙으면 굵게를 유지한다", async () => {
    const source = ["**[@kim2020]**와 일반 [@kim2020] 그리고 *[@lee2021]*.", "", DOC.split("\n").slice(2).join("\n")].join("\n");
    const { body } = await renderMarkdownBody(source, opts);
    const container = document.createElement("div");
    container.innerHTML = body;
    // CommonMark 플랭킹 규칙상 `**[…](…)**글자`는 Strong이 되지 않는다 —
    // 리터럴 ** 가 새어 나오면 안 되고, 강조가 인용 위첨자를 감싸야 한다.
    expect(body).not.toContain("**");
    const cites = container.querySelectorAll("sup.cite");
    expect(cites).toHaveLength(3);
    expect(cites[0]!.closest("strong")).not.toBeNull();
    expect(cites[1]!.closest("strong")).toBeNull();
    expect(cites[2]!.closest("em")).not.toBeNull();
  });

  it("인접 서지를 독립 문단으로 만들고 인라인 서식·참조 링크·리터럴 인용을 유지한다", async () => {
    const source = [
      "본문 [@a] [@b].",
      "[@a]: **Author**. *Title*. `code [@b]` [source][url] [@b].",
      "[@b]: ![cover [@a]](cover.png) &amp; \\*literal\\*.",
      "[@unused]: Uncited.",
      "", "[url]: https://example.com/paper",
    ].join("\r\n");
    const { body } = await renderMarkdownBody(source, opts);
    const container = document.createElement("div");
    container.innerHTML = body;
    expect(container.querySelectorAll("p.ref-entry")).toHaveLength(3);
    expect(container.querySelector("#ref-a strong")?.textContent).toBe("Author");
    expect(container.querySelector("#ref-a em")?.textContent).toBe("Title");
    expect(container.querySelector("#ref-a code")?.textContent).toBe("code [@b]");
    expect(container.querySelector("#ref-a a")?.getAttribute("href")).toBe("https://example.com/paper");
    expect(container.querySelector("#ref-a")?.textContent).toContain(" [@b].");
    expect(container.querySelector("#ref-b img")?.getAttribute("alt")).toBe("cover [@a]");
    expect(container.querySelector("#ref-b")?.textContent).toContain("& *literal*.");
    expect(container.querySelector("#ref-unused .ref-num")).toBeNull();
    expect(container.querySelectorAll("sup.cite")).toHaveLength(2);
    expect(container.querySelector(".ref-entry sup.cite")).toBeNull();
  });

  it("빈 줄 없는 중첩 목록 안에서도 서지 문단과 이동 대상을 보존한다", async () => {
    const source = [
      "본문 [@a] [@b].", "",
      "- Parent", "  [@a]: *First*.",
      "  - Child", "    [@b]: `Second`.",
      "- Sibling",
    ].join("\n");
    const { body } = await renderMarkdownBody(source, opts);
    const container = document.createElement("div");
    container.innerHTML = body;
    expect(container.querySelectorAll(":scope > ul > li")).toHaveLength(2);
    expect(container.querySelector(":scope > ul > li > p#ref-a em")?.textContent).toBe("First");
    expect(container.querySelector(":scope > ul > li > ul > li > p#ref-b code")?.textContent).toBe("Second");
    expect(container.querySelectorAll(".ref-entry")).toHaveLength(2);
    expect(container.querySelectorAll(":scope > ul > li")[1]?.textContent).toBe("Sibling");
  });

  it("서지의 각주를 출력하고 일반 내보내기 정제 경로로 HTML을 처리한다", async () => {
    const source = [
      "본문 [@a].", "",
      '[@a]: **Author**[^note]. <img src="cover.png" onerror="alert(1)"> <script>alert(2)</script>',
      "[@break]: \\newpage", "",
      "[^note]: Note with *detail*.",
    ].join("\n");
    const body = await renderExportBody(source, { ...opts, inlineImages: false });
    const container = document.createElement("div");
    container.innerHTML = body;
    const footnoteLink = container.querySelector("#ref-a .footnote-ref a");
    expect(footnoteLink).not.toBeNull();
    const destination = footnoteLink!.getAttribute("href")!.slice(1);
    expect(container.querySelector(`[id="${destination}"] em`)?.textContent).toBe("detail");
    expect(container.querySelector("#ref-a strong")?.textContent).toBe("Author");
    expect(container.querySelector("#ref-a img")).not.toBeNull();
    expect(container.querySelector("[onerror], script")).toBeNull();
    expect(container.querySelector("#ref-break")?.textContent).toBe("\\newpage");
    expect(container.querySelector(".page-break")).toBeNull();
  });

  it("코드·링크·이미지 설명을 유지하고 실제 본문 인용에만 번호를 붙인다", async () => {
    const source = [
      "````markdown", "```", "[@fake]: Fake", "[@a]", "````", "",
      "`[@a]` \\[@a] [label [@a]](https://example.com) ![설명 [@a]](a.png)", "",
      "본문 [@a,p.12] [@a].", "", "[@a]: Old.", "[@a]: New.",
    ].join("\n");
    const { body } = await renderMarkdownBody(source, opts);
    const container = document.createElement("div");
    container.innerHTML = body;
    expect([...container.querySelectorAll("sup.cite")].map((node) => node.textContent)).toEqual(["[1, p.12]", "[1]"]);
    expect(container.querySelector('a[href="https://example.com"]')?.textContent).toBe("label [@a]");
    expect(container.querySelector("a a")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("설명 [@a]");
    expect(container.querySelector("pre")?.textContent).toContain("[@fake]: Fake");
    expect(container.querySelectorAll('[id="ref-a"]')).toHaveLength(1);
    expect(container.querySelector('[id="ref-a"]')?.textContent).toBe("[1] New.");
    expect(container.textContent).toContain("Old.");
  });
});
