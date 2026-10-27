// 이모지 자동완성 — ":쿼리" 입력 시 후보(Obsidian 표준 흐름). 선택하면 이모지
// 문자 자체를 삽입(:smile: 문법이 아니라 어디서나 렌더되는 표준 텍스트).

import { type Completion, CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { enclosingNode, literalCompletionNodes, linkCompletionNodes } from "./completionContext";

import { EMOJI_ENTRIES } from "./emojiData";

const protectedNodes = new Set([...literalCompletionNodes, ...linkCompletionNodes, "WikiLink", "FootnoteDef"]);
const normalize = (value: string) => value.normalize("NFC").toLowerCase();
const entries = EMOJI_ENTRIES.map((entry) => ({
  entry, name: normalize(entry.n), aliases: [normalize(entry.n), ...normalize(entry.a).split(/\s+/)],
  detail: entry.a.split(/\s+/).find((alias) => /[가-힣]/.test(alias)),
}));

function score(query: string, candidate: typeof entries[number]): number {
  if (candidate.name === query) return 0;
  if (candidate.aliases.includes(query)) return 1;
  if (candidate.aliases.some((alias) => alias.startsWith(query))) return 2;
  return candidate.aliases.some((alias) => alias.includes(query)) ? 3 : -1;
}

function emojiPrefix(context: CompletionContext) {
  if (context.state.readOnly || enclosingNode(context.state, context.pos, protectedNodes)) return null;
  const before = context.matchBefore(/:[\p{L}\p{N}\p{M}+_\-]*/u);
  if (!before || before.text.length === 1) return null;
  const line = context.state.doc.lineAt(before.from);
  const prev = context.state.sliceDoc(line.from, before.from);
  // Explicit boundary: do not treat punctuation in paths, escaped colons or
  // a second colon as a new emoji command.
  if (prev && !/[\s\p{Ps}\p{Pi}]$/u.test(prev)) return null;
  return before;
}

/** ":쿼리"에서 이모지 후보 — 콜론 앞이 줄 시작·공백·여는 괄호일 때만.
 *  시각(12:30)·URL(https://)·프런트매터(key: 값)·한글 콜론(예:) 침범 방지. */
export function emojiCompletions(context: CompletionContext): CompletionResult | null {
  const before = emojiPrefix(context);
  if (!before) return null;
  const q = normalize(before.text.slice(1));
  const scored: { option: Completion; score: number }[] = [];
  for (const candidate of entries) {
    const { entry } = candidate;
    const best = score(q, candidate);
    if (best >= 0) {
      scored.push({
        option: { label: `${entry.e} ${entry.n}`, detail: candidate.detail, type: "text",
          apply: (view, _completion, from, to) => {
            if (from < 0 || to < from || to > view.state.doc.length) return;
            const now = emojiPrefix(new CompletionContext(view.state, to, false, view));
            if (!now || now.from !== from || score(normalize(now.text.slice(1)), candidate) < 0) return;
            // Complete the whole alias, including a trailing shortcode colon,
            // while leaving adjacent prose, punctuation and brackets intact.
            const rest = view.state.sliceDoc(to, view.state.doc.lineAt(to).to);
            const tail = /^[\p{L}\p{N}\p{M}+_\-]*:?/u.exec(rest)![0];
            view.dispatch({ changes: { from, to: to + tail.length, insert: entry.e },
              selection: { anchor: from + entry.e.length },
              annotations: isolateHistory.of("full"), userEvent: "input.complete",
            });
          },
        },
        score: best,
      });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((x, y) => x.score - y.score);
  return {
    from: before.from,
    options: scored.slice(0, 24).map((s) => s.option),
    filter: false,
    update: (_result, _from, _to, next) => emojiCompletions(next),
  };
}
