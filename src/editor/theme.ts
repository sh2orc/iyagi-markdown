// 에디터 테마 — 라이트/다크. 색 토큰은 styles.css의 CSS 변수와 공유한다.
// 글꼴 크기·단 폭은 CSS 변수(--md-font-size 등)로 외부에서 조절한다.

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { Tag, tags as t } from "@lezer/highlight";

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--md-font-size, 15px)",
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    fontFamily:
      'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Apple SD Gothic Neo", monospace',
    lineHeight: "1.65",
    overflowWrap: "break-word",
    padding: "20px 8px 45vh",
  },
  ".cm-content": {
    maxWidth: "var(--md-line-width, 760px)",
    margin: "0 auto",
    caretColor: "var(--md-accent)",
  },
  ".cm-line": { padding: "0 14px" },
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
  // — 마크다운 표시(소스·장식 공용) —
  ".md-h1": { fontWeight: "700", fontSize: "1.7em", lineHeight: "1.3" },
  ".md-h2": { fontWeight: "700", fontSize: "1.45em", lineHeight: "1.35" },
  ".md-h3": { fontWeight: "650", fontSize: "1.25em", lineHeight: "1.4" },
  ".md-h4": { fontWeight: "650", fontSize: "1.12em" },
  ".md-h5": { fontWeight: "600", fontSize: "1em" },
  ".md-h6": { fontWeight: "600", fontSize: "0.95em", opacity: "0.85" },
  ".md-em": { fontStyle: "italic" },
  ".md-strong": { fontWeight: "700" },
  ".md-strike": { textDecoration: "line-through", opacity: 0.7 },
  ".md-codeinline": {
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    backgroundColor: "var(--md-code-bg)",
    borderRadius: "4px",
    padding: "0.12em 0.35em",
    fontSize: "0.92em",
  },
  ".md-link": { color: "var(--md-link)", textDecoration: "underline", textDecorationColor: "var(--md-link-underline)", textUnderlineOffset: "2px", cursor: "pointer" },
  ".md-link-ref": { color: "var(--md-link)", textDecoration: "underline dotted" },
  ".md-url": { color: "var(--md-link)", opacity: 0.9 },
  ".md-quote": {
    borderLeft: "3px solid var(--md-quote-bar)",
    paddingLeft: "12px !important",
    color: "var(--md-quote-text)",
    fontStyle: "italic",
  },
  ".md-quotemark": { color: "var(--md-quote-bar)" },
  ".md-listmark": { color: "var(--md-accent)", fontWeight: "600" },
  ".md-codeblock": {
    backgroundColor: "var(--md-code-bg)",
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: "0.9em",
  },
  ".md-codeblock.cm-line": { padding: "0 16px" },
  ".md-html": { color: "var(--md-raw)" },
  ".md-image": { display: "inline-block", verticalAlign: "middle", maxWidth: "100%" },
  ".md-image img": { maxWidth: "100%", borderRadius: "6px" },
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
  ".md-math-inline .katex": { fontSize: "1.05em" },
  ".md-math-block": {
    textAlign: "center",
    margin: "0.6em 0",
    overflowX: "auto",
    padding: "4px 0",
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
  ".md-diagram": {
    textAlign: "center",
    margin: "0.8em 0",
    overflowX: "auto",
    background: "var(--md-diagram-bg)",
    borderRadius: "8px",
    padding: "10px",
  },
  ".md-diagram[data-pending]": { opacity: 0.4, minHeight: "2em" },
  ".md-diagram-error": { color: "var(--md-error)" },
  ".md-diagram-error-msg": { fontSize: "0.85em", margin: "4px 0" },
  ".md-diagram-error pre": {
    textAlign: "left",
    fontSize: "0.8em",
    opacity: 0.8,
    maxHeight: "8em",
    overflow: "auto",
  },
  ".md-table-wrap": {
    margin: "0.5em 0",
    overflowX: "auto",
  },
  ".md-table": {
    borderCollapse: "collapse",
    border: "1px solid var(--md-border)",
    borderRadius: "6px",
  },
  ".md-table th, .md-table td": {
    border: "1px solid var(--md-border)",
    padding: "5px 12px",
  },
  ".md-table th": { backgroundColor: "var(--md-code-bg)", fontWeight: "600" },
  ".md-task": {
    appearance: "none",
    width: "1em",
    height: "1em",
    border: "1.5px solid var(--md-border-strong)",
    borderRadius: "4px",
    display: "inline-block",
    verticalAlign: "-0.12em",
    marginRight: "0.35em",
    cursor: "pointer",
    position: "relative",
  },
  ".md-task:checked": {
    backgroundColor: "var(--md-accent)",
    borderColor: "var(--md-accent)",
  },
  ".md-task:checked::after": {
    content: "'✓'",
    color: "white",
    fontSize: "0.8em",
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  ".md-hr": {
    border: "none",
    borderTop: "2px solid var(--md-border-strong)",
    margin: "1em 0",
    display: "block",
  },
  ".md-setext-underline": { lineHeight: "0.6" },
  // — 검색 하이라이트 —
  ".md-search-match": { backgroundColor: "var(--md-search-bg)", outline: "1px solid var(--md-search-border)" },
  ".md-search-match-current": { backgroundColor: "var(--md-search-current)" },
});

// 마크다운 구문 색(소스 모드·커서가 있는 블록의 원문 표시에 쓰인다).
export const mdHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.5em", fontWeight: "700", color: "var(--md-heading)" },
  { tag: t.heading2, fontSize: "1.3em", fontWeight: "700", color: "var(--md-heading)" },
  { tag: t.heading3, fontSize: "1.17em", fontWeight: "650", color: "var(--md-heading)" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650", color: "var(--md-heading)" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--md-link)" },
  { tag: t.url, color: "var(--md-link)", textDecoration: "underline" },
  { tag: t.monospace, backgroundColor: "var(--md-code-bg)", borderRadius: "3px" },
  { tag: t.quote, color: "var(--md-quote-text)", fontStyle: "italic" },
  { tag: t.processingInstruction, color: "var(--md-mark)" },
  { tag: [t.bracket, t.paren], color: "var(--md-mark)" },
  { tag: t.separator, color: "var(--md-mark)" },
  { tag: t.meta, color: "var(--md-raw)" },
  // — 코드 하이라이트(중첩 파서 — 기본 톤만) —
  { tag: [t.keyword, t.moduleKeyword], color: "var(--md-syn-keyword)", fontWeight: "600" },
  { tag: [t.controlKeyword, t.operatorKeyword], color: "var(--md-syn-keyword)" },
  { tag: [t.name, t.deleted, t.character, t.macroName], color: "var(--md-syn-name)" },
  { tag: [t.propertyName], color: "var(--md-syn-property)" },
  { tag: [t.variableName], color: "var(--md-syn-variable)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--md-syn-function)" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--md-syn-constant)" },
  { tag: [t.definition(t.name), t.separator], color: "var(--md-syn-name)" },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.self, t.namespace], color: "var(--md-syn-type)" },
  { tag: [t.operator, t.operatorKeyword], color: "var(--md-syn-operator)" },
  { tag: [t.regexp, t.special(t.string)], color: "var(--md-syn-regexp)" },
  { tag: [t.string], color: "var(--md-syn-string)" },
  { tag: [t.special(t.string)], color: "var(--md-syn-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--md-syn-comment)", fontStyle: "italic" },
  { tag: [t.number], color: "var(--md-syn-number)" },
  { tag: [t.bool, t.null], color: "var(--md-syn-constant)" },
  { tag: t.invalid, color: "var(--md-error)" },
  { tag: t.tagName, color: "var(--md-syn-tag)" },
  { tag: t.attributeName, color: "var(--md-syn-attr)" },
]);

// 커스텀 노드(InlineMath·MathBlock)에도 색을 입힌다.
export const mathTags = {
  InlineMath: Tag.define(),
  MathBlock: Tag.define(),
};

export function editorSyntaxHighlighting() {
  return syntaxHighlighting(mdHighlightStyle);
}
