import { CompletionContext, pickedCompletion, type Completion, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { isolateHistory } from "@codemirror/commands";

const token = /^[\w#+.-]+$/;
const choices = languages.flatMap((language) => {
  // Markdown reads only the first whitespace-delimited info token. Names such
  // as "Common Lisp" must be inserted using a recognized single-token alias.
  const name = language.name.toLowerCase();
  const insert = token.test(name) ? name : language.alias.find((alias) => token.test(alias));
  return insert ? [{ language, insert, search: [name, ...language.alias.map((alias) => alias.toLowerCase())] }] : [];
});

function fencePrefix(context: CompletionContext) {
  if (context.state.readOnly) return null;
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (node.name !== "FencedCode") {
    if (!node.parent) return null;
    node = node.parent;
  }
  const mark = node.firstChild;
  const line = context.state.doc.lineAt(context.pos);
  // Only the opening CodeMark on this line, never a closing fence or a fence
  // example in another code block. Container prefixes are outside this range.
  if (!mark || mark.name !== "CodeMark" || mark.from < line.from || mark.to > context.pos) return null;
  const prefix = context.state.sliceDoc(mark.to, context.pos);
  const match = /^([ \t]*)([\w#+.-]*)$/.exec(prefix);
  if (!match) return null;
  const spacing = /^[ \t]*/.exec(context.state.sliceDoc(mark.to, line.to))![0];
  return { from: mark.from, tokenFrom: mark.to + spacing.length, query: match[2].toLowerCase() };
}

function score(search: string[], query: string): number {
  return search.some((value) => value === query) ? 0 : search.some((value) => value.startsWith(query)) ? 1 : -1;
}

export function fenceLanguageCompletions(context: CompletionContext): CompletionResult | null {
  const prefix = fencePrefix(context);
  if (!prefix) return null;
  const options: Completion[] = choices
    .map((choice) => ({ ...choice, rank: score(choice.search, prefix.query) }))
    .filter((choice) => choice.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 30)
    .map(({ language, insert, search }): Completion => ({
      label: language.name, detail: language.alias.slice(0, 4).join(", "), type: "text",
      apply: (view, completion, from, to) => {
        if (from < 0 || to < from || to > view.state.doc.length) return;
        const current = fencePrefix(new CompletionContext(view.state, to, false, view));
        if (!current || current.from !== from || score(search, current.query) < 0) return;
        const tailFrom = Math.max(to, current.tokenFrom);
        const tail = /^[\w#+.-]*/.exec(view.state.sliceDoc(tailFrom, view.state.doc.lineAt(to).to))![0];
        view.dispatch({
          changes: { from: current.tokenFrom, to: tailFrom + tail.length, insert },
          selection: { anchor: current.tokenFrom + insert.length },
          annotations: [isolateHistory.of("full"), pickedCompletion.of(completion)], userEvent: "input.complete",
        });
      },
    }));
  if (!options.length) return null;
  // Include the fence marker so deleting the complete query keeps the result
  // active and can restore the full list without removing the opening fence.
  return { from: prefix.from, options, filter: false,
    update: (_result, _from, _to, next) => fenceLanguageCompletions(next),
  };
}
