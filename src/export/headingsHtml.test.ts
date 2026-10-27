// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { collectHeadings } from "../links";
import { renderMarkdownBody } from "./html";
import citationHeadings from "../../fixtures/heading-anchors.json";

const opts = { title: "t", baseDir: "", theme: "light" as const };

async function headingIds(markdown: string): Promise<string[]> {
  const { body } = await renderMarkdownBody(markdown, opts);
  const doc = new DOMParser().parseFromString(body, "text/html");
  return [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => h.id);
}

describe("export heading anchors", () => {
  it("reserves original citation headings before used footnote headings", async () => {
    const { markdown, bodyAnchors, footnoteAnchors } = citationHeadings;
    const { body } = await renderMarkdownBody(markdown, opts);
    const document = new DOMParser().parseFromString(body, "text/html");
    const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")];
    expect(headings.filter((node) => !node.closest(".footnotes")).map((node) => node.id)).toEqual(bodyAnchors);
    expect(headings.filter((node) => node.closest(".footnotes")).map((node) => node.id)).toEqual(footnoteAnchors);
    expect(collectHeadings(markdown).map((heading) => heading.slug)).toEqual(bodyAnchors);
    expect(new Set(headings.map((node) => node.id)).size).toBe(headings.length);
    expect(document.getElementById("ref-findings")?.textContent).toBe("[1] Findings");
    expect(document.querySelector('a[href="#ref-findings"]')?.textContent).toBe("jump");
  });

  it("keeps suffix collisions unique and matches editor navigation", async () => {
    const markdown = "# A\n\n# A\n\n# A 1\n\n> # A\n\n# A 1\n\n# A 1 1\n";
    const ids = await headingIds(markdown);
    expect(ids).toEqual(["a", "a-1", "a-1-1", "a-2", "a-1-2", "a-1-1-1"]);
    expect(ids).toEqual(collectHeadings(markdown).map((h) => h.slug));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shares raw inline source slugs for formatted titles", async () => {
    const markdown = [
      "# **Strong** `code` [link](dest.md)",
      "",
      "> # 인용",
      "",
      "# A &amp; B",
      "",
      "#",
    ].join("\n");
    expect(await headingIds(markdown)).toEqual(collectHeadings(markdown).map((h) => h.slug));
  });

  it("starts a new allocation sequence for each exported document", async () => {
    expect(await headingIds("# A\n\n# A\n")).toEqual(["a", "a-1"]);
    expect(await headingIds("# A\n")).toEqual(["a"]);
  });
});
