// 표 캡션(Pandoc ": 캡션") 테스트 — HTML 변환·원문 스캔 양쪽 규칙의 정확성.

import { describe, expect, it } from "vitest";

import { applyTableCaptions, tableCaptionLines } from "./tableCaption";

describe("tableCaptionLines(원문 스캔)", () => {
  it("표 바로 다음 ': ' 줄을 캡션으로 — 줄 번호는 캡션 줄", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |\n: 판매 실적\n\n본문\n";
    expect(tableCaptionLines(md)).toEqual([{ line: 4, text: "판매 실적" }]);
  });

  it("빈 줄 하나 사이도 허용·캡션 없으면 수집 안 함", () => {
    const md = "| a |\n|---|\n| 1 |\n\n: 메모\n";
    expect(tableCaptionLines(md)[0]?.text).toBe("메모");
    expect(tableCaptionLines("| a |\n|---|\n본문\n")).toEqual([]);
  });
});

describe("applyTableCaptions(HTML 변환)", () => {
  it("표+<p>: 캡션</p>을 figure/figcaption으로 — 번호 매김", () => {
    const html = "<table><tr><td>a</td></tr></table>\n<p>: 첫 표</p>\n<p>본문</p>";
    const out = applyTableCaptions(html);
    expect(out).toContain('<figure class="tbl-fig">');
    expect(out).toContain("<figcaption>표 1 — 첫 표</figcaption>");
    expect(out).not.toContain("<p>: 첫 표</p>");
  });

  it("빈 캡션은 원문 유지·여러 표는 순차 번호", () => {
    expect(applyTableCaptions("<table></table><p>:</p>")).toContain("<p>:</p>");
    const two = applyTableCaptions("<table></table><p>: A</p><table></table><p>: B</p>");
    expect(two).toContain("표 1 — A");
    expect(two).toContain("표 2 — B");
  });
});
