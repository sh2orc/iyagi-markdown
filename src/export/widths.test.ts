// 내보내기 이미지 폭 반영 — 사이드카 드래그 값이 <img> style로 정확히
// 붙는지(편집기·내보내기 일관성, Word "그림 크기" 상당).

import { describe, expect, it } from "vitest";

import { applyImageWidths } from "./html";

describe("applyImageWidths", () => {
  it("매칭 src에 width:%·height:auto style을 넣는다", () => {
    const html = `<p><img src="assets/a.png" alt="a"></p><p><img src="assets/b.png" alt="b"></p>`;
    const out = applyImageWidths(html, { "assets/a.png": 40 });
    expect(out).toContain(`<img src="assets/a.png" style="width:40%;height:auto" alt="a">`);
    expect(out).not.toContain('assets/b.png" style');
  });

  it("퍼센트 인코딩된 표기도 매칭한다", () => {
    const html = `<img src="assets/%EC%82%AC%EC%A7%84.png" alt="한글">`;
    const out = applyImageWidths(html, { "assets/사진.png": 70 });
    expect(out).toContain('style="width:70%;height:auto"');
  });

  it("기존 style의 width/height는 교체하고 나머지는 보존한다", () => {
    const html = `<img src="a.png" style="border-radius:6px;width:100%">`;
    const out = applyImageWidths(html, { "a.png": 55 });
    expect(out).toContain('style="border-radius:6px;width:55%;height:auto"');
  });

  it("범위 밖 값은 5~100으로 묶는다·빈 맵은 무동작", () => {
    expect(applyImageWidths('<img src="a.png">', { "a.png": 300 })).toContain("width:100%");
    expect(applyImageWidths('<img src="a.png">', { "a.png": 1 })).toContain("width:5%");
    expect(applyImageWidths('<img src="a.png">', {})).toBe('<img src="a.png">');
  });

  it("XHTML 자가폐쇄 img에도 붙는다(EPUB 경로)", () => {
    const out = applyImageWidths(`<img src="x.png"/>`, { "x.png": 30 });
    expect(out).toBe(`<img src="x.png" style="width:30%;height:auto"/>`);
  });
});

describe("applyTableWidths / tableKey", () => {
  it("마크다운 원문 키와 렌더된 HTML 키가 일치한다(서식·엔티티 포함)", async () => {
    const { mdTableKey, htmlTableKey } = await import("../editor/tableKey");
    const md = "| **이름** | 값 & 단위 |\n|---|---|\n| a | 1 |";
    const html = "<table><thead><tr><th><strong>이름</strong></th><th>값 &amp; 단위</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>";
    expect(mdTableKey(md)).toBe(htmlTableKey(html));
  });

  it("매칭 표에 colgroup 비율을 넣는다", async () => {
    const { applyTableWidths } = await import("./html");
    const { mdTableKey } = await import("../editor/tableKey");
    const html = "<table><thead><tr><th>a</th><th>b</th></tr></thead></table>";
    const out = applyTableWidths(html, { [mdTableKey("| a | b |\n|---|---|")]: [100, 300] });
    expect(out).toContain("<colgroup>");
    expect(out).toContain('width:25.00%');
    expect(out).toContain('width:75.00%');
  });

  it("키가 없으면 무동작·1열 폭은 무시", async () => {
    const { applyTableWidths } = await import("./html");
    const html = "<table><tr><th>x</th></tr></table>";
    expect(applyTableWidths(html, {})).toBe(html);
    expect(applyTableWidths(html, { x: [500] })).toBe(html);
  });
});
