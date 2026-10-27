import { afterEach, expect, it, vi } from "vitest";
import { DOC_TEMPLATES, templateContent, templateName, templateOutline } from "./templates";
import { makeT } from "../i18n";

afterEach(() => { vi.useRealTimers(); });

it("앱을 켜 둔 채 날짜가 바뀌어도 생성 시점의 로컬 날짜를 사용하고 원본은 보존한다", () => {
  vi.useFakeTimers();
  const report = DOC_TEMPLATES.find((template) => template.id === "report")!;
  const original = report.content;
  vi.setSystemTime(new Date(2026, 9, 21, 23, 59));
  expect(templateContent(report, "ko")).toContain("date: 2026-10-21");
  vi.setSystemTime(new Date(2026, 9, 22, 0, 1));
  expect(templateContent(report, "ko")).toContain("date: 2026-10-22");
  expect(report.content).toBe(original);
});

it("모든 템플릿은 한국어·영어 이름과 본문을 제공하며 날짜 자리표시자를 남기지 않는다", () => {
  for (const template of DOC_TEMPLATES) {
    for (const lang of ["ko", "en"] as const) {
      expect(makeT(lang).lang).toBe(lang);
      expect(templateName(template, lang)).toBe(lang === "ko" ? template.nameKo : template.nameEn);
      const content = templateContent(template, lang, new Date(2026, 0, 2, 0, 15));
      expect(content).not.toContain("{{date}}");
      if (template.id === "blank") expect(content).toBe("");
      else {
        expect(template.contentEn).toBeTruthy();
        expect(content).toContain("date: 2026-01-02");
        expect(templateOutline(template, lang)).not.toBe("");
      }
    }
  }
});
