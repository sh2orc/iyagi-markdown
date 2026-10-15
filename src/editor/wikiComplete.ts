// 위키링크 자동완성 — "[[" 입력 시 워크스페이스 문서 목록. Obsidian·
// [[로어링크]] 표준 흐름. 원문에는 선택한 [[이름]] 텍스트만 삽입된다(§4-1).

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

import { emojiCompletions } from "./emojiComplete";

/** 문서 목록 공급자 — App이 위키 인덱스에서 만들어 넣는다(경로|표시). */
export interface WikiDoc {
  /** 인덱스 키(표시·삽입에 쓰는 이름 — stem 또는 상대경로). */
  name: string;
  path: string;
}

let docsProvider: () => WikiDoc[] = () => [];
let tagsProvider: () => string[] = () => [];

/** 자동완성 목록 공급자 등록(App이 트리 갱신 때 다시 등록). */
export function setWikiDocsProvider(fn: (() => WikiDoc[]) | null): void {
  docsProvider = fn ?? (() => []);
}

/** \ud0dc\uadf8 \ubaa9\ub85d \uacf5\uae09\uc790 \ub4f1\ub85d(App\uc774 \ubb38\uc11c \uc2a4\ucea8 \ud6c4 \uc124\uc815). */
export function setTagListProvider(fn: (() => string[]) | null): void {
  tagsProvider = fn ?? (() => []);
}

/** "[[위치" 에서 문서 이름 후보. */
function wikiCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/\[\[[^\[\]\n]*/);
  if (!before) return null;
  // 닫는 ]]까지 이미 있으면(완성된 링크 안) 추가 완성하지 않는다.
  if (before.text.includes("]]")) return null;
  const typed = before.text.slice(2).toLowerCase();
  const docs = docsProvider();
  if (docs.length === 0) return null;
  const options: Completion[] = docs
    .filter((d) => !typed || fuzzy(typed, d.name.toLowerCase()))
    .slice(0, 30)
    .map((d) => ({
      label: d.name,
      // 닫는 괄호까지 넣고 커서를 ]] 앞에 — 타이핑 없이 바로 완성.
      apply: `${d.name}]]`,
      detail: d.path,
      type: "text",
    }));
  if (options.length === 0) return null;
  return {
    from: before.from + 2,
    options,
    validFor: /^[^\[\]\n]*$/,
  };
}

/** 서브시퀀스 매칭 — "노트마" → "노트/마케팅" 매칭용. */
function fuzzy(query: string, text: string): boolean {
  let qi = 0;
  for (const ch of text) {
    if (qi < query.length && ch === query[qi]) qi++;
  }
  return qi === query.length;
}

export function wikiAutocompletion() {
  return autocompletion({
    override: [combinedMatcher],
    activateOnTyping: true,
    icons: false,
    closeOnBlur: true,
  });
}

/** "[[" wikilink + "#" tag + ":이모지" in one matcher (wikilink first). */
function combinedMatcher(context: CompletionContext): CompletionResult | null {
  const wiki = wikiCompletions(context);
  if (wiki) return wiki;
  const tag = tagCompletions(context);
  if (tag) return tag;
  return emojiCompletions(context);
}

/** "#pos" - workspace tag candidates (heading "#" excluded). */
function tagCompletions(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(/#[\p{L}\p{N}_\-\/]*/u);
  if (!before) return null;
  const typed = before.text.slice(1);
  if (typed.length === 0) return null;
  if (typed[0] === " ") return null;
  if (/^\d/u.test(typed)) return null;
  const tags = tagsProvider();
  if (tags.length === 0) return null;
  const q = typed.toLowerCase();
  const options: Completion[] = tags
    .filter((t) => !q || t.toLowerCase().includes(q))
    .slice(0, 20)
    .map((t) => ({
      label: t,
      apply: t,
      type: "keyword",
    }));
  if (options.length === 0) return null;
  return {
    from: before.from + 1,
    options,
    validFor: /^[\p{L}\p{N}_\-\/]*$/u,
  };
}
