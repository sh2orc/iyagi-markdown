// 사이드카 다이어그램 폭 — 읽기/참조 페인·HTML·PDF·EPUB 내보내기가 편집기와 같은 폭.
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

vi.mock("../plugins/mermaid", () => ({
  renderMermaidForExport: async (code: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100%" style="max-width: 100px;"><text>${code.length}</text></svg>`,
}));

import { diagramKey } from "../editor/diagramKey";
import { renderExportBody, sizedDiagram } from "./html";

const SVG = "<svg viewBox=\"0 0 10 10\"></svg>";

describe("sizedDiagram", () => {
  it("폭이 없거나 100%면 그대로", () => {
    expect(sizedDiagram(SVG, undefined)).toBe(SVG);
    expect(sizedDiagram(SVG, 100)).toBe(SVG);
  });

  it("폭(%)이 있으면 인라인 스타일 상자로 감싼다(하한 10%)", () => {
    expect(sizedDiagram(SVG, 40)).toContain('class="diagram-box" style="display:inline-block;width:40%;max-width:100%"');
    expect(sizedDiagram(SVG, 3)).toContain("width:10%");
  });
});

describe("renderExportBody — 다이어그램 폭", () => {
  const code = "graph TD;\nA-->B;";
  const md = `# 제목\n\n\`\`\`mermaid\n${code}\n\`\`\`\n`;

  it("사이드카 키(코드 내용)가 맞는 다이어그램만 줄어든다", async () => {
    const sized = await renderExportBody(md, {
      title: "t", baseDir: "/tmp", theme: "light",
      diagramWidths: { [diagramKey(code)]: 35 },
    });
    const doc = new DOMParser().parseFromString(sized, "text/html");
    const box = doc.querySelector(".diagram > .diagram-box") as HTMLElement | null;
    expect(box).not.toBeNull();
    expect(box!.style.width).toBe("35%");
    expect(box!.querySelector("svg")).not.toBeNull();

    const plain = await renderExportBody(md, {
      title: "t", baseDir: "/tmp", theme: "light",
      diagramWidths: { [diagramKey("graph TD; X-->Y;")]: 35 },
    });
    expect(plain).not.toContain("diagram-box");
    expect(plain).toContain('class="diagram"');
  });
});
