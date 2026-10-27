// Citation analysis shared by editor widgets, review, completion and exports.
// Positions are original UTF-16 offsets; syntax masking never changes length.
import { GFM, parser } from "@lezer/markdown";
import { frontMatterLen } from "./frontmatter";
import { mathSyntax } from "./mathSyntax";
import { wikiLinkSyntax } from "./wiki";
import type { Text } from "@codemirror/state";

export interface CiteDef { line: number; entry: string }
export interface CiteReference { from: number; to: number; key: string; suffix?: string }
interface Definition extends CiteDef { key: string; from: number; to: number; indent: string }
export interface CitationNumbering {
  defs: Map<string, CiteDef>;
  order: string[];
  num: Map<string, number>;
  references: CiteReference[];
  definitions: Definition[];
  definitionLines: Set<number>;
}

const documentCache = new WeakMap<Text, CitationNumbering>();
/** CodeMirror Text is immutable. Preview, completion and review share one scan
 * for each document version; selection-only changes reuse it. Treat as read-only. */
export function citationNumberingForDocument(doc: Text): CitationNumbering {
  let result = documentCache.get(doc);
  if (!result) { result = citeNumbering(doc.toString()); documentCache.set(doc, result); }
  return result;
}

const DEF_RE = /^([ \t]*)\[@([^\][\s]+)\]:[ \t]*(.*)$/;
const citationParser = parser.configure([GFM, mathSyntax, wikiLinkSyntax, {
  // Lezer represents unresolved shortcut references as Link nodes too. Reserve
  // citation brackets so ordinary citations stay text and enclosing links/images
  // can still be recognized as complete protected nodes.
  defineNodes: ["Citation"],
  parseInline: [{ name: "iyagiCitationAnalysis", before: "Link", parse(cx, next, pos) {
    if (next !== 91 || cx.char(pos + 1) !== 64) return -1;
    for (let end = pos + 2; end < cx.end; end++) {
      if (cx.char(end) === 10 || cx.char(end) === 91) return -1;
      if (cx.char(end) === 93) return cx.addElement(cx.elt("Citation", pos, end + 1));
    }
    return -1;
  } }],
}]);
const protectedNames = new Set([
  "FencedCode", "CodeBlock", "InlineCode", "Escape", "Link", "Image", "Autolink",
  "LinkReference", "HTMLBlock", "HTMLTag", "Comment", "CommentBlock",
  "ProcessingInstruction", "ProcessingInstructionBlock", "InlineMath", "MathBlock", "WikiLink", "Highlight",
]);
type Span = { from: number; to: number };

function overlaps(spans: Span[], from: number, to: number): boolean {
  let lo = 0, hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid].to <= from) lo = mid + 1;
    else hi = mid;
  }
  return lo < spans.length && spans[lo].from < to;
}

export function citeNumbering(text: string): CitationNumbering {
  const result: CitationNumbering = { defs: new Map(), order: [], num: new Map(), references: [], definitions: [], definitionLines: new Set() };
  if (!text.includes("[@")) return result;
  const fmEnd = frontMatterLen(text);
  let offset = 0;
  const rows = text.split("\n").map((raw, index) => {
    const row = { text: raw.replace(/\r$/, ""), from: offset, line: index + 1 };
    offset += raw.length + 1;
    return row;
  });
  const candidates: Definition[] = [];
  // Prevent definitions from consuming nearby citations as Markdown reference links.
  const masked = rows.map((row) => {
    const match = DEF_RE.exec(row.text);
    if (!match) return text.slice(row.from, row.from + row.text.length);
    const [, indent, key, entry] = match;
    candidates.push({ key, entry, indent, line: row.line, from: row.from, to: row.from + row.text.length });
    return `${indent}x${row.text.slice(indent.length + 1)}`;
  });
  let source = masked.map((line, i) => line + (text[rows[i].from + rows[i].text.length] === "\r" ? "\r" : "")).join("\n");
  if (fmEnd) source = source.slice(0, fmEnd).replace(/[^\r\n]/g, " ") + source.slice(fmEnd);
  const spans: Span[] = fmEnd ? [{ from: 0, to: fmEnd }] : [];
  const notes: Span[] = [];
  const tree = citationParser.parse(source);
  tree.iterate({ enter(node) {
    if (protectedNames.has(node.name)) { spans.push({ from: node.from, to: node.to }); return false; }
    if (node.name === "FootnoteDef") { notes.push({ from: node.from, to: node.to }); return false; }
  } });
  // FootnoteDef is an opaque editor node. Parse its inline content as a normal
  // paragraph as well, to protect code/links/math within the definition.
  for (const note of notes) {
    citationParser.parse(`x ${source.slice(note.from, note.to)}`).iterate({ enter(node) {
      if (protectedNames.has(node.name)) {
        spans.push({ from: Math.max(note.from, note.from + node.from - 2), to: note.from + node.to - 2 });
        return false;
      }
    } });
  }
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else merged.push({ ...span });
  }
  for (const definition of candidates) {
    const start = definition.from + definition.indent.length;
    if (overlaps(merged, start, start + 2)) continue;
    result.definitions.push(definition);
    result.definitionLines.add(definition.line);
    result.defs.set(definition.key, { line: definition.line, entry: definition.entry });
  }
  const seen = new Set<string>();
  for (const row of rows) {
    if (result.definitionLines.has(row.line)) continue;
    for (const match of row.text.matchAll(/\[@([^\]\n]+)\]/g)) {
      const from = row.from + match.index;
      const to = from + match[0].length;
      const inner = match[1];
      const comma = inner.indexOf(",");
      const key = (comma < 0 ? inner : inner.slice(0, comma)).trim();
      const suffix = comma < 0 ? undefined : inner.slice(comma + 1).trim();
      if (!key || /[\s\[]/.test(key) || inner.includes("[") || text[from - 1] === "[" || text[to] === "]"
        || overlaps(merged, from, to)) continue;
      result.references.push({ from, to, key, suffix });
      if (seen.has(key)) continue;
      seen.add(key);
      result.order.push(key);
      if (result.defs.has(key)) result.num.set(key, result.num.size + 1);
    }
  }
  return result;
}

export function parseCiteDefs(text: string): Map<string, CiteDef> { return citeNumbering(text).defs; }
export function citeDisplay(key: string, suffix: string | undefined, numbering: CitationNumbering): string | null {
  const n = numbering.num.get(key);
  return n === undefined ? null : suffix ? `[${n}, ${suffix}]` : `[${n}]`;
}
export function isCiteDefLine(text: string): boolean { return DEF_RE.test(text); }

/** 단일 인용 패턴 호환 헬퍼. 구문 문맥/원문 위치가 필요한 호출자는
 *  citeNumbering의 references를 사용한다. */
export function citeRegExp(): RegExp {
  return /\[@([^\][\s,]+)(?:,\s*([^\]]*))?\]/g;
}
export function brokenCitations(text: string, numbering = citeNumbering(text)): Array<{ key: string; pos: number }> {
  return numbering.references.filter((ref) => !numbering.defs.has(ref.key)).map((ref) => ({ key: ref.key, pos: ref.from }));
}

/** Locate only references wholly inside an editor chunk, without rescanning text. */
export function citationsInRange(numbering: CitationNumbering, from: number, to: number): CiteReference[] {
  const refs = numbering.references;
  let lo = 0, hi = refs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (refs[mid].from < from) lo = mid + 1;
    else hi = mid;
  }
  const result: CiteReference[] = [];
  for (let i = lo; i < refs.length && refs[i].from < to; i++) if (refs[i].to <= to) result.push(refs[i]);
  return result;
}

