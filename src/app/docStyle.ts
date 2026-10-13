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

/** 스타일을 호스트 요소의 CSS 변수로 반영한다. */
export function applyDocStyle(el: HTMLElement, style: DocStyle | null, globalFontSize: number): void {
  const s = style ?? DEFAULT_DOC_STYLE;
  el.style.setProperty("--md-font-size", `${s.fontSize > 0 ? s.fontSize : globalFontSize}px`);
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

/** 문서가 저장된 스타일을 갖고 있는가(전부 기본이면 저장할 게 없다). */
export function isDefaultStyle(style: DocStyle): boolean {
  return (
    style.font === DEFAULT_DOC_STYLE.font &&
    style.fontSize === 0 &&
    style.lineHeight === 0 &&
    style.paraSpace === "normal" &&
    !style.accent &&
    !style.firstLineIndent &&
    style.textAlign === "left" &&
    Object.keys(style.imageWidths ?? {}).length === 0 &&
    Object.keys(style.tableWidths ?? {}).length === 0
  );
}
