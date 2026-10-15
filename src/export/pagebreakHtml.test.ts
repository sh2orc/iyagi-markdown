// HTML 내보내기의 `\newpage` 변환 — 페이지 나눔 div·리터럴 잔여 부재.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { renderMarkdownBody } from "./html";

describe("페이지 나눔 HTML 변환", () => {
  const opts = { title: "t", baseDir: "", theme: "light" as const };

  it("\\newpage 문단이 div.page-break로 바뀐다(리터럴 잔여 없음)", async () => {
    const { body } = await renderMarkdownBody("앞\n\n\\newpage\n\n뒤", opts);
    expect(body).toContain('<div class="page-break"></div>');
    expect(body).not.toContain("newpage");
    expect(body).toContain("<p>앞</p>");
    expect(body).toContain("<p>뒤</p>");
  });

  it("인라인(문단 일부)은 변환하지 않는다", async () => {
    const { body } = await renderMarkdownBody("설명 \\newpage 계속", opts);
    expect(body).not.toContain("page-break");
  });
});
