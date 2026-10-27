// 문서별 스타일 적용 — 저장은 SQLite(원문 불변), 적용은 에디터 컨테이너의
// CSS 변수 덮어쓰기. 폰트 스택은 macOS 기본 조합.

import type { DocStyle } from "../api";

export const FONT_STACKS: Record<DocStyle["font"], string | null> = {
  system: null, // 전역 기본(--md-prose-font)
  serif:
    '"New York", ui-serif, Georgia, "Apple SD Gothic Neo", "Nanum Myeongjo", "Noto Serif KR", serif',
  round: 'ui-rounded, -apple-system, "SF Pro Rounded", "Apple SD Gothic Neo", sans-serif',
  mono: null, // --md-code-font
};

export const PARA_SPACES: Record<DocStyle["paraSpace"], string> = {
  tight: "0.02em",
  normal: "0.15em",
  relaxed: "0.35em",
};

export const DEFAULT_DOC_STYLE: DocStyle = {
  font: "system",
  fontSize: 0,
  lineHeight: 0,
  paraSpace: "normal",
  accent: null,
  highlightColor: null,
  firstLineIndent: false,
  textAlign: "left",
  imageWidths: {},
  tableWidths: {},
};

/** 스타일 프리셋(Word 스타일 갤러리에 대응) — 원문 불변, 사이드카에 기록. */
export interface StylePreset {
  id: string;
  nameKo: string;
  nameEn: string;
  style: DocStyle;
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: "report",
    nameKo: "보고서",
    nameEn: "Report",
    style: { font: "system", fontSize: 0, lineHeight: 1.6, paraSpace: "normal", textAlign: "justify", firstLineIndent: true, accent: null, highlightColor: null, imageWidths: {}, tableWidths: {} },
  },
  {
    id: "blog",
    nameKo: "블로그",
    nameEn: "Blog",
    style: { font: "round", fontSize: 0, lineHeight: 1.7, paraSpace: "relaxed", textAlign: "left", firstLineIndent: false, accent: null, highlightColor: null, imageWidths: {}, tableWidths: {} },
  },
  {
    id: "memo",
    nameKo: "메모",
    nameEn: "Memo",
    style: { font: "system", fontSize: 0, lineHeight: 1.5, paraSpace: "tight", textAlign: "left", firstLineIndent: false, accent: null, highlightColor: null, imageWidths: {}, tableWidths: {} },
  },
  {
    id: "paper",
    nameKo: "논문",
    nameEn: "Paper",
    style: { font: "serif", fontSize: 0, lineHeight: 1.9, paraSpace: "normal", textAlign: "justify", firstLineIndent: true, accent: null, highlightColor: null, imageWidths: {}, tableWidths: {} },
  },
  {
    id: "code",
    nameKo: "개발 노트",
    nameEn: "Dev Notes",
    style: { font: "mono", fontSize: 0, lineHeight: 1.55, paraSpace: "normal", textAlign: "left", firstLineIndent: false, accent: null, highlightColor: null, imageWidths: {}, tableWidths: {} },
  },
];

/** 줄 폭(페이지 폭)의 확정 값 — 기준 글꼴(15px) 대비 실제 글꼴로 스케일.
 *  줌(⌘+/−)은 글꼴 크기를 바꾸므로 폭을 그대로 두면 글자가 커질수록
 *  줄당 글자 수가 줄어든다 — Word의 줌처럼 페이지가 함께 커지게 한다.
 *  0(전체 폭)은 스케일 없이 "100%". */
const LINE_WIDTH_BASE_FONT = 15;
export function scaledLineWidth(lineWidth: number, fontPx: number): string {
  if (lineWidth <= 0) return "100%";
  return `${Math.round(lineWidth * (fontPx / LINE_WIDTH_BASE_FONT))}px`;
}

/** 스타일을 호스트 요소의 CSS 변수로 반영한다. */
export function applyDocStyle(
  el: HTMLElement,
  style: DocStyle | null,
  globalFontSize: number,
  lineWidth: number,
): void {
  const s = style ?? DEFAULT_DOC_STYLE;
  const effectiveFont = s.fontSize > 0 ? s.fontSize : globalFontSize;
  el.style.setProperty("--md-font-size", `${effectiveFont}px`);
  // 문서별 글꼴 크기가 다르면 같은 줄 폭도 다른 measure가 된다 — 실효 글꼴로.
  el.style.setProperty("--md-line-width", scaledLineWidth(lineWidth, effectiveFont));
  el.style.setProperty(
    "--md-line-height",
    s.lineHeight > 0 ? String(s.lineHeight) : "1.55",
  );
  el.style.setProperty("--md-para-space", PARA_SPACES[s.paraSpace]);
  el.style.setProperty(
    "--md-prose-font",
    s.font === "mono" ? "var(--md-code-font)" : (FONT_STACKS[s.font] ?? ""),
  );
  if (s.font === "system") el.style.removeProperty("--md-prose-font");
  if (s.accent) el.style.setProperty("--md-accent", s.accent);
  else el.style.removeProperty("--md-accent");
  // 형광펜 색은 강조색과 독립(83차 — accent 없이도 적용되게).
  if (s.highlightColor) el.style.setProperty("--md-hl", `#${s.highlightColor}`);
  else el.style.removeProperty("--md-hl");
  el.style.setProperty(
    "--md-text-indent",
    s.firstLineIndent ? "1.25em" : "0em",
  );
  el.style.setProperty("--md-text-align", s.textAlign);
}
