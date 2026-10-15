// 이모지 자동완성 — ":쿼리" 입력 시 후보(Obsidian 표준 흐름). 선택하면 이모지
// 문자 자체를 삽입(:smile: 문법이 아니라 어디서나 렌더되는 표준 텍스트).

import { type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";

import { EMOJI_ENTRIES } from "./emojiData";

/** ":쿼리"에서 이모지 후보 — 콜론 앞이 줄 시작·공백·여는 괄호일 때만.
 *  시각(12:30)·URL(https://)·프런트매터(key: 값)·한글 콜론(예:) 침범 방지. */
export function emojiCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/:[\p{L}\p{N}+_\-]*/u);
  if (!before) return null;
  const typed = before.text.slice(1);
  if (typed.length === 0) return null;
  const line = context.state.doc.lineAt(before.from);
  const prevCh = before.from > line.from ? line.text[before.from - line.from - 1] : "";
  if (prevCh && /[\p{L}\p{N}\p{M}]/u.test(prevCh)) return null;
  const q = typed.toLowerCase();
  const scored: { option: Completion; score: number }[] = [];
  for (const entry of EMOJI_ENTRIES) {
    let best = -1;
    for (const alias of `${entry.n} ${entry.a}`.toLowerCase().split(/\s+/)) {
      if (alias.startsWith(q)) best = Math.max(best, 0);
      else if (alias.includes(q)) best = Math.max(best, 1);
    }
    if (best >= 0) {
      const ko = entry.a.split(/\s+/).find((a) => /[가-힣]/.test(a));
      scored.push({
        option: { label: `${entry.e} ${entry.n}`, apply: entry.e, detail: ko, type: "text" },
        score: best,
      });
    }
  }
  if (scored.length === 0) return null;
  scored.sort((x, y) => x.score - y.score);
  return {
    from: before.from + 1,
    options: scored.slice(0, 24).map((s) => s.option),
    validFor: /^[\p{L}\p{N}+_\-]*$/u,
  };
}
