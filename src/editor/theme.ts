// 에디터 테마 — Word/Typora 수준의 본문 타이포그래피.
// 산문은 비례 폰트(시스템 산세리프), 코드만 고정폭. 행간은 본문 1.55,
// 코드 1.5로 컴팩트하게 하고 블록 사이 간격은 빈 줄 축소로 붙인다.
// 색 토큰은 styles.css의 CSS 변수와 공유.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--md-font-size, 15px)",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    fontFamily: "var(--md-prose-font)",
    lineHeight: "var(--md-line-height, 1.55)",
    letterSpacing: "-0.005em",
    // 한글 어절 중간에서 끊지 않는다(Word 기본) — 못 끊을 땐 overflow-wrap이
    // 긴 URL·코드 등을 안전하게 처리한다.
    wordBreak: "keep-all",
    overflowWrap: "break-word",
    padding: "26px 10px 40vh",
  },
  ".cm-content": {
    maxWidth: "var(--md-line-width, 100%)",
    margin: "0 auto",
    caretColor: "var(--md-accent)",
    paddingBottom: "2px",
    // 스크롤 앵커링은 CM의 스크롤 보정과 겹쳐 점프를 만든다(위젯 높이 변화 시).
    overflowAnchor: "none",
  },
  ".cm-line": {
    position: "relative",
    padding: "0 16px",
    // 줄 간 리듬: 기본 0.1em — 문단·제목은 클래스로 더 붙인다.
    paddingBottom: "0.1em",
    paddingTop: "0.1em",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--md-accent)",
    borderLeftWidth: "2px",
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "var(--md-selection) !important",
  },
  ".cm-gutters": { display: "none" },
  ".cm-activeLine": { backgroundColor: "transparent" },

  // — 문단: 컴팩트(빈 줄이 리듬을 맡는다) — 문서별 간격 설정 지원.
  // 문단 줄 — padding 없음: 모든 텍스트 줄이 순수 행간으로 동일 높이.
  // (문단 padding은 줄바꿈 줄마다 걸려 빈 줄과 어긋나고 CM 높이 측정도
  // 흔들었음 — 2026-10-13 사용자 보고. 문단 사이 여백은 빈 줄이 담당.)
  ".md-para": {
    // 한국어 문서 관례의 첫 줄 들여쓰기(문서 스타일 옵션).
    textIndent: "var(--md-text-indent, 0em)",
    textAlign: "var(--md-text-align, left)",
  },
  // 마크다운 빈 줄 — 높이 오버라이드 없음(.cm-content 행간 상속이 단일 원천).
  // 빈 줄과 본문 줄이 어긋나 보이면 여기에 높이 속성이 다시 들어간 것.
  ".md-blank": {},

  // — 제목(Word 기본 스케일: 본문 11pt 기준 H1≈16pt·H2≈13pt·H3≈12pt) —
  ".md-h1": {
    fontWeight: "750",
    fontSize: "1.45em",
    lineHeight: "1.3",
    letterSpacing: "-0.015em",
    color: "var(--md-heading)",
    paddingTop: "0.42em",
    paddingBottom: "0.18em",
  },
  ".md-h2": {
    fontWeight: "700",
    fontSize: "1.24em",
    lineHeight: "1.32",
    letterSpacing: "-0.012em",
    color: "var(--md-heading)",
    paddingTop: "0.42em",
    paddingBottom: "0.16em",
  },
  ".md-h3": {
    fontWeight: "680",
    fontSize: "1.12em",
    lineHeight: "1.36",
    letterSpacing: "-0.008em",
    color: "var(--md-heading)",
    paddingTop: "0.38em",
    paddingBottom: "0.14em",
  },
  ".md-h4": { fontWeight: "660", fontSize: "1.02em", lineHeight: "1.4", color: "var(--md-heading)", paddingTop: "0.34em", paddingBottom: "0.12em" },
  ".md-h5": { fontWeight: "640", fontSize: "0.97em", lineHeight: "1.42", color: "var(--md-heading)", paddingTop: "0.3em", paddingBottom: "0.1em" },
  ".md-h6": { fontWeight: "640", fontSize: "0.94em", lineHeight: "1.42", color: "var(--md-fg-dim)", paddingTop: "0.3em", paddingBottom: "0.1em" },
  ".md-setext-underline": { lineHeight: "0.5" },

  // — 목록: 걸침 들여쓰기(첫 시각 줄만 왼쪽으로 당겨 글머리가 들여쓰기
  //    기준점에 놓이고, 줄바꿈된 내용은 글머리 뒤에 정렬된다). 깊이는 CSS 변수로.
  ".md-li": {
    "--md-hang": "1.25em",
    "--md-depth-em": "0em",
    paddingLeft: "calc(16px + var(--md-depth-em))",
    textIndent: "calc(-1 * var(--md-hang))",
    marginLeft: "var(--md-hang)",
    paddingBottom: "0.14em",
  },
  ".md-depth-1": { "--md-depth-em": "1.5em" },
  ".md-depth-2": { "--md-depth-em": "3em" },
  ".md-depth-3": { "--md-depth-em": "4.5em" },
  ".md-depth-4": { "--md-depth-em": "6em" },
  ".md-depth-5": { "--md-depth-em": "7.5em" },
  ".md-depth-6": { "--md-depth-em": "9em" },
  // 체크박스 항목: 상자+간격 폭만큼 걸침.
  ".md-task-line": { "--md-hang": "1.7em" },
  ".md-listmark": { color: "var(--md-accent)", fontWeight: "600" },
  ".md-bullet": {
    color: "var(--md-accent)",
    display: "inline-block",
    width: "0.95em",
    textAlign: "center",
    fontWeight: "700",
    fontSize: "0.9em",
    lineHeight: "1",
    // 한글 글자의 시각 중앙(약 0.36em 위)에 점을 맞춘다 — 기준선(0.24em)에
    // 그대로 두면 점이 살짝 아래로 처 보인다.
    verticalAlign: "0.12em",
  },

  // — 인용: 막대 + 옅은 배경 —
  ".md-quote": {
    borderLeft: "3px solid var(--md-quote-bar)",
    backgroundColor: "var(--md-quote-bg)",
    paddingLeft: "14px !important",
    color: "var(--md-quote-text)",
  },
  ".md-quotemark": { color: "var(--md-quote-bar)" },

  // — 인라인 —
  ".md-em": { fontStyle: "italic" },
  ".md-strong": { fontWeight: "700", letterSpacing: "0" },
  ".md-strike": { textDecoration: "line-through", opacity: 0.7 },
  ".md-codeinline": {
    fontFamily: "var(--md-code-font)",
    fontSize: "0.88em",
    backgroundColor: "var(--md-code-bg)",
    border: "1px solid var(--md-code-border)",
    borderRadius: "5px",
    padding: "0.08em 0.32em",
  },
  ".md-link": {
    color: "var(--md-link)",
    textDecoration: "underline",
    textDecorationColor: "var(--md-link-underline)",
    textDecorationThickness: "1px",
    textUnderlineOffset: "2.5px",
    cursor: "pointer",
  },
  ".md-link-ref": { color: "var(--md-link)", textDecoration: "underline dotted" },
  ".md-url": {
    color: "var(--md-link)",
    textDecoration: "underline",
    textDecorationColor: "var(--md-link-underline)",
    textUnderlineOffset: "2.5px",
    cursor: "pointer",
  },
  ".md-html": { color: "var(--md-raw)" },
  ".md-tag": {
    color: "var(--md-accent)",
    backgroundColor: "var(--md-accent-soft)",
    borderRadius: "999px",
    padding: "0.05em 0.5em",
    fontSize: "0.9em",
    cursor: "pointer",
  },
  ".md-footnote-ref": {
    color: "var(--md-link)",
    fontSize: "0.72em",
    verticalAlign: "super",
    lineHeight: "0",
    cursor: "help",
  },
  ".md-bookmark": {
    boxShadow: "inset 3px 0 0 var(--md-accent)",
  },
  ".md-bookmark::before": {
    content: "'★'",
    position: "absolute",
    left: "2px",
    fontSize: "0.7em",
    color: "var(--md-accent)",
    opacity: 0.8,
  },
  ".md-footnote-def": {
    fontSize: "0.82em",
    color: "var(--md-fg-dim)",
    borderTop: "1px solid var(--md-border)",
    marginTop: "0.5em",
    paddingTop: "0.35em",
  },

  // — 코드 블록: 하나의 붙는 카드(줄마다 배경이 이어지고 끝만 둥글게) —
  ".md-codeblock": {
    fontFamily: "var(--md-code-font)",
    fontSize: "0.86em",
    lineHeight: "1.5",
    letterSpacing: "0",
    backgroundColor: "var(--md-code-bg)",
    paddingTop: "0.06em",
    paddingBottom: "0.06em",
  },
  ".md-codeblock.cm-line": { padding: "0 18px" },
  ".md-code-first": {
    borderRadius: "9px 9px 0 0",
    paddingTop: "0.45em",
    boxShadow: "inset 0 1px 0 var(--md-code-border)",
  },
  ".md-code-last": {
    borderRadius: "0 0 9px 9px",
    paddingBottom: "0.45em",
    boxShadow: "inset 0 -1px 0 var(--md-code-border)",
  },
  ".md-codeblock.md-code-first.md-code-last": { borderRadius: "9px" },
  ".md-codeblock-indented": { paddingLeft: "18px" },

  ".md-footnote-def.cm-line": { padding: "0 18px" },

  // — 하이라이트 ==텍스트== — 테마별 노랑 배경 —
  ".md-highlight": {
    backgroundColor: "color-mix(in srgb, var(--md-hl, #ffd60a) 38%, transparent)",
    borderRadius: "3px",
    padding: "0.05em 0.15em",
  },

  // — 위키링크(커스텀 문법 [[..]]) — 해석되면 강조 링크, 아니면 흐린 점선 —
  ".md-wikilink": {
    color: "var(--md-accent)",
    cursor: "pointer",
    borderBottom: "1px solid color-mix(in srgb, var(--md-accent) 45%, transparent)",
  },
  ".md-wikilink.is-missing": {
    color: "var(--md-fg-dim)",
    borderBottom: "1px dashed var(--md-border)",
  },

  // — 프론트매터: 원문(커서로 드러날 때)은 흐린 메타 톤, 렌더는 키·값 패널 —
  ".md-frontmatter": {
    color: "var(--md-fg-dim)",
    backgroundColor: "var(--md-code-bg)",
    fontFamily: "var(--md-code-font)",
    fontSize: "0.84em",
  },
  ".md-frontmatter.cm-line": { padding: "0 18px" },
  ".md-frontmatter-panel": {
    margin: "0.1em 0 0.75em",
    padding: "8px 14px",
    borderRadius: "9px",
    backgroundColor: "var(--md-code-bg)",
    border: "1px solid var(--md-border)",
    display: "table",
  },
  ".fm-row": { display: "flex", gap: "10px", fontSize: "0.84em", lineHeight: "1.7" },
  ".fm-key": {
    color: "var(--md-fg-dim)",
    flex: "none",
    minWidth: "52px",
    fontFamily: "var(--md-code-font)",
  },
  ".fm-value": { color: "var(--md-fg)", wordBreak: "break-word" },

  // — 수평선 —
  ".md-hr": {
    border: "none",
    borderTop: "2px solid var(--md-border)",
    margin: "0.35em 0",
    display: "block",
  },

  // — 이미지 —
  ".md-image": { display: "inline-block", verticalAlign: "bottom", maxWidth: "100%", position: "relative" },
  ".md-img-handle": {
    position: "absolute",
    right: "-6px",
    bottom: "-6px",
    width: "12px",
    height: "12px",
    borderRadius: "3px",
    background: "var(--md-accent)",
    border: "2px solid #fff",
    boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
    cursor: "ew-resize",
    display: "none",
  },
  ".md-image:hover .md-img-handle": { display: "block" },
  ".md-image img": { maxWidth: "100%", borderRadius: "6px", display: "block" },
  ".md-occurrence": {
    background: "color-mix(in srgb, var(--md-accent, #4f46e5) 14%, transparent)",
    borderRadius: "2px",
  },
  ".md-long-sentence": {
    textDecoration: "underline dotted rgba(210, 130, 30, 0.55)",
    textUnderlineOffset: "3px",
    textDecorationSkipInk: "none",
  },
  ".md-comment-line": {
    borderLeft: "2px solid rgba(210, 130, 30, 0.65)",
    background: "rgba(210, 130, 30, 0.05)",
  },
  ".md-table-cap-line": {
    textAlign: "center",
    color: "var(--md-raw, #8a919c)",
    fontSize: "0.85em",
  },
  ".md-image-caption": {
    display: "block",
    fontSize: "0.8em",
    color: "var(--md-raw, #8a919c)",
    textAlign: "center",
    marginTop: "2px",
  },
  ".md-img-line": { textAlign: "center", paddingBottom: "0.3em", paddingTop: "0.3em" },
  ".md-image-missing": {
    color: "var(--md-error)",
    border: "1px dashed var(--md-error)",
    borderRadius: "4px",
    padding: "2px 8px",
    fontSize: "0.85em",
  },
  ".md-image-blocked": {
    color: "var(--md-raw)",
    border: "1px dashed var(--md-border)",
    borderRadius: "4px",
    padding: "2px 8px",
    fontSize: "0.85em",
    cursor: "pointer",
  },
  ".md-image-off": { color: "var(--md-raw)", fontSize: "0.85em" },

  // — 수식 —
  ".md-math-inline .katex": { fontSize: "1.02em" },
  // contain: 비동기로 채워지는 위젯의 재배치·재페인트 범위를 위젯 안으로 묶는다.
  ".md-math-block": {
    textAlign: "center",
    margin: "0.25em 0",
    overflowX: "auto",
    padding: "2px 0",
    contain: "layout style",
  },
  ".md-math-pending": { opacity: 0.35, minWidth: "3em", display: "inline-block" },
  ".md-math-error": {
    color: "var(--md-error)",
    border: "1px dashed var(--md-error)",
    borderRadius: "4px",
    padding: "4px 8px",
    display: "inline-block",
  },
  ".md-math-error-msg": { display: "block", fontSize: "0.8em", marginTop: "2px" },

  // — 다이어그램 —
  ".md-diagram": {
    textAlign: "center",
    margin: "0.3em 0",
    overflowX: "auto",
    background: "var(--md-diagram-bg)",
    border: "1px solid var(--md-code-border)",
    borderRadius: "10px",
    padding: "12px",
    contain: "layout style",
  },
  ".md-diagram[data-pending]": {
    opacity: 0.4,
    minHeight: "2em",
    // 렌더 중임을 알리는 부드러운 펄스(opacity만 — GPU 컴포지).
    animation: "md-pending-pulse 1.2s ease-in-out infinite",
  },
  "@keyframes md-pending-pulse": {
    "0%, 100%": { opacity: "0.35" },
    "50%": { opacity: "0.65" },
  },
  ".md-diagram-error": { color: "var(--md-error)" },
  ".md-diagram-error-msg": { fontSize: "0.85em", margin: "4px 0" },
  ".md-diagram-error pre": {
    textAlign: "left",
    fontSize: "0.8em",
    opacity: 0.8,
    maxHeight: "8em",
    overflow: "auto",
  },

  // — 표(Word 라이트 그리드) —
  ".md-table-wrap": { margin: "0.25em 0 0.8em", overflowX: "auto", contain: "layout style" },
  ".md-table": { borderCollapse: "collapse", fontSize: "0.95em", lineHeight: "1.45" },
  ".md-table th, .md-table td": {
    border: "1px solid var(--md-table-line)",
    padding: "5px 12px",
  },
  ".md-table th": {
    position: "relative", // 열 폭 핸들이 th에 붙게
    backgroundColor: "var(--md-table-head)",
    fontWeight: "650",
    borderBottom: "2px solid var(--md-border-strong)",
    cursor: "pointer",
  },
  ".md-table th:hover": {
    backgroundColor: "var(--md-accent-soft)",
  },
  ".md-col-handle": {
    position: "absolute",
    right: "-4px",
    top: "10%",
    bottom: "10%",
    width: "7px",
    cursor: "col-resize",
  },
  ".md-col-handle::after": {
    content: "' '",
    display: "block",
    margin: "0 3px",
    height: "100%",
    borderRight: "2px solid transparent",
  },
  ".md-col-handle:hover::after, .md-col-handle:active::after": {
    borderRightColor: "var(--md-accent)",
  },
  ".md-table th[data-align]::after": {
    content: "attr(data-align)",
    fontSize: "0.75em",
    opacity: 0.5,
    marginLeft: "0.35em",
  },
  ".md-table tr:last-child td": { borderBottom: "1px solid var(--md-table-line)" },

  // — 체크박스 —
  ".md-task": {
    appearance: "none",
    width: "0.95em",
    height: "0.95em",
    border: "1.5px solid var(--md-border-strong)",
    borderRadius: "4px",
    display: "inline-block",
    verticalAlign: "-0.08em",
    marginRight: "0.55em",
    cursor: "pointer",
    position: "relative",
    flex: "none",
  },
  ".md-task:checked": { backgroundColor: "var(--md-accent)", borderColor: "var(--md-accent)" },
  ".md-task:checked::after": {
    content: "'✓'",
    color: "#fff",
    fontSize: "0.78em",
    fontWeight: "700",
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },

  // — 검색 —
  ".md-search-match": { backgroundColor: "var(--md-search-bg)", outline: "1px solid var(--md-search-border)", borderRadius: "2px" },
  ".md-search-match-current": { backgroundColor: "var(--md-search-current)", borderRadius: "2px" },
});

// 소스 모드(장식 없음)에서도 마크다운 구문색이 읽히게 — 폰트는 산문 폰트 유지.
export const mdHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "700", color: "var(--md-heading)" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700", color: "var(--md-heading)" },
  { tag: t.heading3, fontSize: "1.15em", fontWeight: "650", color: "var(--md-heading)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650", color: "var(--md-heading)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--md-link)" },
  { tag: t.url, color: "var(--md-link)", textDecoration: "underline" },
  { tag: t.monospace, fontFamily: "var(--md-code-font)", fontSize: "0.9em", backgroundColor: "var(--md-code-bg)", borderRadius: "3px" },
  { tag: t.quote, color: "var(--md-quote-text)" },
  { tag: t.processingInstruction, color: "var(--md-mark)" },
  { tag: [t.bracket, t.paren], color: "var(--md-mark)" },
  { tag: t.separator, color: "var(--md-mark)" },
  { tag: t.meta, color: "var(--md-raw)" },
  // 코드 하이라이트(중첩 파서) — 고정폭.
  { tag: [t.keyword, t.moduleKeyword], color: "var(--md-syn-keyword)", fontWeight: "600" },
  { tag: [t.controlKeyword, t.operatorKeyword], color: "var(--md-syn-keyword)" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: "var(--md-syn-name)" },
  { tag: [t.propertyName], color: "var(--md-syn-property)" },
  { tag: [t.variableName], color: "var(--md-syn-variable)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--md-syn-function)" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--md-syn-constant)" },
  { tag: [t.definition(t.name)], color: "var(--md-syn-name)" },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.self, t.namespace], color: "var(--md-syn-type)" },
  { tag: [t.operator], color: "var(--md-syn-operator)" },
  { tag: [t.regexp, t.special(t.string)], color: "var(--md-syn-regexp)" },
  { tag: [t.string], color: "var(--md-syn-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--md-syn-comment)", fontStyle: "italic" },
  { tag: [t.bool, t.null], color: "var(--md-syn-constant)" },
  { tag: t.invalid, color: "var(--md-error)" },
  { tag: t.tagName, color: "var(--md-syn-tag)" },
  { tag: t.attributeName, color: "var(--md-syn-attr)" },
]);

export function editorSyntaxHighlighting() {
  return syntaxHighlighting(mdHighlightStyle);
}
