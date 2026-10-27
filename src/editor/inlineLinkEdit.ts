import { parser } from "@lezer/markdown";
import type { EditorView } from "@codemirror/view";
import { captureAsyncEdit } from "./asyncEdit";

export interface LinkFields { text: string; url: string }

function decodeInline(source: string): string {
  return source.replace(/\\([!-/:-@\[-`{-~])|&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/gi, (match, escaped: string | undefined) => {
    if (escaped) return escaped;
    // The match contains only an entity, never a tag or document markup.
    const textarea = document.createElement("textarea");
    textarea.innerHTML = match;
    return textarea.value;
  });
}

/** Read inline syntax from parser boundaries, including balanced URL parentheses,
 * escaped labels, angle destinations and optional titles. Reference links remain
 * reference links and are not silently converted by this editor. */
export function inlineLinkParts(source: string) {
  const node = parser.parse(source).topNode.firstChild?.firstChild;
  if (!node || (node.name !== "Link" && node.name !== "Image") || node.from !== 0 || node.to !== source.length) return null;
  const marks = node.getChildren("LinkMark");
  const opening = marks.find((mark) => source.slice(mark.from, mark.to) === "(");
  const labelEnd = marks.find((mark) => source.slice(mark.from, mark.to) === "]");
  if (!opening || !labelEnd || source.slice(marks[marks.length - 1]?.from) !== ")") return null;
  const labelFrom = node.name === "Image" ? 2 : 1;
  const destination = node.getChild("URL");
  const urlFrom = destination?.from ?? opening.to, urlTo = destination?.to ?? opening.to;
  const rawUrl = source.slice(urlFrom, urlTo);
  const titleNode = node.getChild("LinkTitle");
  return { kind: node.name === "Image" ? "image" : "link", labelFrom, labelTo: labelEnd.from, urlFrom, urlTo,
    title: titleNode ? decodeInline(source.slice(titleNode.from + 1, titleNode.to - 1)) : null,
    text: decodeInline(source.slice(labelFrom, labelEnd.from)),
    url: decodeInline(rawUrl.startsWith("<") ? rawUrl.slice(1, -1) : rawUrl) };
}

export function updateInlineLink(source: string, next: LinkFields): string | null {
  const parts = inlineLinkParts(source);
  if (!parts) return null;
  const label = next.text === parts.text ? source.slice(parts.labelFrom, parts.labelTo)
    : next.text.replace(/\r?\n/g, " ").replace(/[!-/:-@\[-`{-~]/g, "\\$&");
  const destination = next.url === parts.url ? source.slice(parts.urlFrom, parts.urlTo)
    : next.url.replace(/[\\\s<>()&]/g, (ch) => ch === "&" ? "&amp;"
      : ch === "(" ? "%28" : ch === ")" ? "%29" : encodeURIComponent(ch));
  return source.slice(0, parts.labelFrom) + label + source.slice(parts.labelTo, parts.urlFrom)
    + destination + source.slice(parts.urlTo);
}

export function captureInlineLinkEdit(view: EditorView, from: number, to: number) {
  const source = view.state.sliceDoc(from, to), parts = inlineLinkParts(source);
  if (!parts) return null;
  const pending = captureAsyncEdit(view, "link-dialog", { from, to });
  if (!pending) return null;
  return {
    initial: { text: parts.text, url: parts.url, from, to },
    kind: parts.kind,
    finish: pending.finish,
    apply(next: LinkFields): boolean {
      if (!pending.current()) return false;
      const replacement = updateInlineLink(source, next);
      if (replacement === null) return false;
      if (replacement === source) { pending.finish(); return true; }
      return pending.replace(replacement, parts.kind === "image" ? "input.editImage" : "input.editLink");
    },
  };
}

export type InlineLinkEdit = NonNullable<ReturnType<typeof captureInlineLinkEdit>>;
