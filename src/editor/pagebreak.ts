// 페이지 나눔(Word Ctrl+Enter에 해당) — pandoc 규약 `\newpage` 줄.
// 편집기 장식·내보내기(HTML/DOCX/PDF)가 같은 판정을 공유한다(의존성 없는 순수 모듈).

export const PAGEBREAK_RE = /^\\(?:newpage|pagebreak|page)$/;

/** 한 줄 전체가 페이지 나눔 매크로인지(앞뒤 공백 허용). */
export function isPageBreakLine(text: string): boolean {
  return PAGEBREAK_RE.test(text.trim());
}

/** 삽입용 원문(자체 문단이 되도록 호출쪽에서 빈 줄을 확보한다). */
export function pageBreakMarkdown(): string {
  return "\\newpage";
}
