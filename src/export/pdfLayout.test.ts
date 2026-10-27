// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { buildExportHtml } from "./html";
afterEach(() => vi.unstubAllGlobals());

it("인쇄 용지·방향·언어·다단·쪽번호·목차를 최종 HTML에 보존한다", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ text: async () => "" })));
  const html = await buildExportHtml("---\ncolumns: 2\n---\n# Heading", {
    title: "Report", baseDir: "", theme: "light", forPdf: true, paper: "a5", orientation: "landscape",
    lang: "en", pageNumbers: true, pdfHeader: "Header", pdfFooter: "Footer", marginMm: 12, scale: 1.25,
    preRendered: '<h1 id="heading">Heading</h1>', frontLists: { toc: true, lof: false, lot: false },
  });
  const doc = new DOMParser().parseFromString(html, "text/html");
  expect(doc.documentElement.lang).toBe("en");
  expect(doc.querySelector("article")?.getAttribute("data-columns")).toBe("2");
  expect(doc.querySelector("style")?.textContent).toContain("@page{size:A5 landscape;margin:0;}");
  expect(doc.querySelector('a[href="#heading"]')).not.toBeNull();
  expect(doc.querySelector("#iyagi-pdf-chrome")?.textContent).toContain("var core = true");
  expect(doc.querySelector("#iyagi-pdf-chrome")?.textContent).toContain('"Footer"');
});
