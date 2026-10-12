// 위키링크 자동완성 — "[[" 입력 시 워크스페이스 문서 목록. Obsidian·
// [[로어링크]] 표준 흐름. 원문에는 선택한 [[이름]] 텍스트만 삽입된다(§4-1).

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";

/** 문서 목록 공급자 — App이 위키 인덱스에서 만들어 넣는다(경로|표시). */
export interface WikiDoc {
  /** 인덱스 키(표시·삽입에 쓰는 이름 — stem 또는 상대경로). */
  name: string;
  path: string;
}

let docsProvider: () => WikiDoc[] = () => [];

/** 자동완성 목록 공급자 등록(App이 트리 갱신 때 다시 등록). */
export function setWikiDocsProvider(fn: (() => WikiDoc[]) | null): void {
  docsProvider = fn ?? (() => []);
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
    override: [wikiCompletions],
    activateOnTyping: true,
    icons: false,
    closeOnBlur: true,
  });
}
