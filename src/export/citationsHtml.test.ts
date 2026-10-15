// 인용·서지 HTML 내보내기 — 위첨자 링크·서지 문단·끊긴 인용 원문 보존.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { renderMarkdownBody } from "./html";

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
});
