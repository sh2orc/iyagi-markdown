// 콜아웃 HTML 내보내기 — 인용문 → 카드 구조 재조립(표준 토큰, html:false 안전).
// @vitest-environment jsdom
import { expect, it } from "vitest";
import { renderMarkdownBody } from "./html";

const opts = { title: "t", baseDir: "", theme: "light" as const };

it("[!유형] 인용문이 콜아웃 카드 div로 나온다 — 아이콘·제목·본문", async () => {
  const { body } = await renderMarkdownBody("> [!tip] 캐시 규칙\n> 내용 줄입니다.\n\n> 일반 인용은 그대로\n", opts);
  expect(body).toContain('class="callout callout-tip"');
  expect(body).toContain('data-callout="tip"');
  expect(body).toContain("callout-title");
  expect(body).toContain("💡");
  expect(body).toContain("캐시 규칙");
  expect(body).toContain("내용 줄입니다");
  expect(body).toContain("<blockquote>"); // 일반 인용은 영향 없음
});

it("별칭·접기 표식·제목 없음·리스트 본문도 성립한다", async () => {
  const { body } = await renderMarkdownBody("> [!tldr]+ 요약\n> - 항목\n> - 항목\n\n> [!warning]\n> 경고 내용\n", opts);
  expect(body).toContain("callout-abstract"); // tldr → abstract
  expect(body).toContain("<ul>"); // 본문 목록 보존
  expect(body).toContain("⚠️"); // 제목 없는 warning — 아이콘만
});

it("EPUB 정제(toXhtml) 경로도 div 구조를 유지한다", async () => {
  const { toXhtml } = await import("./epub");
  const { body } = await renderMarkdownBody("> [!success] 완료\n> 다 되었다\n", opts);
  // toXhtml은 본문을 XHTML로 정제 — div/p/속성이 유지되는지
  const xhtml = toXhtml(body);
  expect(xhtml).toContain("callout callout-success");
  expect(xhtml).toContain("✅");
});
