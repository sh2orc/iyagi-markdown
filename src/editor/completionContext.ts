import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

export const literalCompletionNodes = new Set([
  "FencedCode", "CodeBlock", "InlineCode", "FrontMatter", "InlineMath", "MathBlock",
  "HTMLBlock", "HTMLTag", "Comment", "CommentBlock",
]);
export const linkCompletionNodes = new Set(["Link", "Image", "Autolink", "URL", "LinkTitle", "LinkReference"]);

/** Inspect existing parse state; completion updates must not force a full parse. */
export function enclosingNode(state: EditorState, pos: number, names: ReadonlySet<string>): string | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  for (; node; node = node.parent) if (names.has(node.name)) return node.name;
  return null;
}

export const literalContext = (state: EditorState, pos: number) => enclosingNode(state, pos, literalCompletionNodes);
