import { CompletionContext, type Completion, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";
import type { SyntaxNode } from "@lezer/common";
import { citationNumberingForDocument, isCiteDefLine } from "./citations";
import { literalContext, linkCompletionNodes } from "./completionContext";

const normalize = (value: string) => value.normalize("NFC").toLowerCase();

function citePrefix(context: CompletionContext) {
  if (context.state.readOnly || literalContext(context.state, context.pos)) return null;
  const before = context.matchBefore(/\[@[^\[\],\s]*/);
  if (!before) return null;
  const line = context.state.doc.lineAt(before.from);
  if (isCiteDefLine(line.text)) return null;
  const prefix = context.state.sliceDoc(line.from, before.from);
  if (prefix.endsWith("[") || (/\\+$/.exec(prefix)?.[0].length ?? 0) % 2) return null;
  // 미닫 [ 가 앞에 있으면 다른 링크 라벨 안에 중첩 — [label [@sm]](url) 등.
  if ((prefix.match(/\[/g) ?? []).length > (prefix.match(/\]/g) ?? []).length) return null;
  let node: SyntaxNode | null = syntaxTree(context.state).resolveInner(context.pos, -1);
  for (; node; node = node.parent) {
    if (node.name === "WikiLink" || node.name === "Highlight") return null;
    if (!linkCompletionNodes.has(node.name)) continue;
    // A bare [@key] is a shortcut Link in the editor grammar. An enclosing
    // ordinary link/image or an explicit destination is not a citation.
    if (node.name !== "Link" || node.from !== before.from ||
        !/^\[@[^\[\]\n]+\]$/.test(context.state.sliceDoc(node.from, node.to))) return null;
  }
  return before;
}

/** Complete a defined key without rewriting its locator or bibliography entry. */
export function citeCompletions(context: CompletionContext): CompletionResult | null {
  const before = citePrefix(context);
  if (!before) return null;
  const query = normalize(before.text.slice(2));
  const definitions = citationNumberingForDocument(context.state.doc).defs;
  const options: Completion[] = [...definitions]
    .filter(([key]) => !/[\s,\[\]]/.test(key) && normalize(key).includes(query))
    .slice(0, 20)
    .map(([key, definition]): Completion => ({
      label: key, type: "variable", detail: definition.entry.replace(/\s+/g, " ").slice(0, 160),
      apply: (view, _completion, from, to) => {
        if (from < 0 || to < from || to > view.state.doc.length) return;
        const now = citePrefix(new CompletionContext(view.state, to, false, view));
        if (!now || now.from !== from || !normalize(key).includes(normalize(now.text.slice(2))) ||
            !citationNumberingForDocument(view.state.doc).defs.has(key)) return;
        const rest = view.state.sliceDoc(to, view.state.doc.lineAt(to).to);
        const tail = /^[^\s,\[\]]*/.exec(rest)![0];
        const afterKey = rest.slice(tail.length);
        const closed = /^([ \t]*(?:,[^\[\]\n]*)?)\]/.exec(afterKey);
        const openLocator = !closed && /^[ \t]*,/.test(afterKey);
        const insert = `[@${key}${closed ? `${closed[1]}]` : openLocator ? "" : "]"}`;
        view.dispatch({
          changes: { from, to: to + tail.length + (closed?.[0].length ?? 0), insert },
          selection: { anchor: from + insert.length },
          annotations: isolateHistory.of("full"), userEvent: "input.complete",
        });
      },
    }));
  if (!options.length) return null;
  return { from: before.from, options, filter: false,
    update: (_result, _from, _to, next) => citeCompletions(next),
  };
}
