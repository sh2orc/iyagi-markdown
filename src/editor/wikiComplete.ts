// 위키링크 자동완성 — "[[" 입력 시 워크스페이스 문서 목록.
// 표시명과 실제 대상은 분리하며 구문에 넣을 수 없는 이름은 Markdown 링크로 삽입한다.

import {
  autocompletion,
  type Completion,
  CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { enclosingNode, literalContext as inLiteral, linkCompletionNodes as linkNodes } from "./completionContext";
import { previewConfigField } from "./livePreview";
import { parseWikiLink } from "./wiki";
import { relPath } from "../paths";
import { slugifyHeading } from "../links";
import { updateInlineLink } from "./inlineLinkEdit";

import { emojiCompletions } from "./emojiComplete";
import { slashCompletions } from "./slashMenu";
import { citeCompletions } from "./citeComplete";
import { fenceLanguageCompletions } from "./fenceComplete";

/** 문서 목록 공급자 — App이 위키 인덱스에서 만들어 넣는다(경로|표시). */
export interface WikiDoc {
  /** Display/search label. The destination is independent of this label. */
  name: string;
  path: string;
  /** Unambiguous wiki key; null means use an ordinary Markdown link. */
  target?: string | null;
}

let docsProvider: () => WikiDoc[] = () => [];
let tagsProvider: () => string[] = () => [];

const tagExcludedNodes = new Set([...linkNodes, "WikiLink"]);

function wikiPrefix(context: CompletionContext) {
  if (context.state.readOnly || inLiteral(context.state, context.pos)) return null;
  const before = context.matchBefore(/\[\[[^\[\]#|\n]*/);
  if (!before) return null;
  // A single closing bracket can make Lezer see an inner shortcut Link in
  // "[[name]". Allow that node, but not an enclosing ordinary link or image.
  let node: import("@lezer/common").SyntaxNode | null = syntaxTree(context.state).resolveInner(context.pos, -1);
  for (; node; node = node.parent) if (linkNodes.has(node.name) && node.from < before.from) return null;
  // Odd backslashes escape the opening delimiter.
  const prefix = context.state.sliceDoc(context.state.doc.lineAt(before.from).from, before.from);
  if ((/\\+$/.exec(prefix)?.[0].length ?? 0) % 2) return null;
  return before;
}

/** 자동완성 목록 공급자 등록(App이 트리 갱신 때 다시 등록). */
export function setWikiDocsProvider(fn: (() => WikiDoc[]) | null): void {
  docsProvider = fn ?? (() => []);
}

/** 태그 목록 공급자 등록(App이 문서 스캔 후 설정). */
export function setTagListProvider(fn: (() => string[]) | null): void {
  tagsProvider = fn ?? (() => []);
}

/** "[[위치" 에서 문서 이름 후보. */
function wikiCompletions(context: CompletionContext): CompletionResult | null {
  const before = wikiPrefix(context);
  if (!before) return null;
  const typed = before.text.slice(2).toLowerCase();
  const docs = docsProvider();
  if (docs.length === 0) return null;
  const options: Completion[] = docs
    .filter((d) => !typed || fuzzy(typed, d.name) || fuzzy(typed, d.target ?? "") || fuzzy(typed, d.path))
    .slice(0, 30)
    .map((d): Completion => ({
      label: d.name,
      apply: (view, _completion, from, to) => {
        if (from < 0 || to < from || to > view.state.doc.length) return;
        const now = wikiPrefix(new CompletionContext(view.state, to, false, view));
        if (!now || now.from !== from) return;
        const current = docsProvider().find((candidate) => candidate.path === d.path);
        if (!current) return;
        const query = now.text.slice(2);
        if (query && !fuzzy(query, current.name) && !fuzzy(query, current.target ?? "") && !fuzzy(query, current.path)) return;
        const rest = view.state.sliceDoc(to, view.state.doc.lineAt(to).to);
        const closing = /^[^\[\]\n]*\]\]?/.exec(rest);
        let suffix = "", end = to;
        if (closing) {
          const body = closing[0].replace(/\]\]?$/, "");
          const marker = body.search(/[#|]/);
          if (marker >= 0) suffix = body.slice(marker);
          end += closing[0].length;
        }
        const target = current.target === undefined ? current.name : current.target;
        let insert: string;
        if (target !== null) insert = `[[${target}${suffix}]]`;
        else {
          const { anchor, display } = parseWikiLink(`[[x${suffix}]]`);
          const base = view.state.field(previewConfigField, false)?.baseDir ?? "";
          const path = (base ? relPath(base, current.path) : current.path).split("/").map(encodeURIComponent).join("/");
          const url = path + (anchor ? `#${encodeURIComponent(slugifyHeading(anchor))}` : "");
          insert = updateInlineLink("[x]()", { text: display ?? current.name, url })!;
        }
        view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length },
          annotations: isolateHistory.of("full"), userEvent: "input.complete",
        });
      },
      detail: d.path,
      type: "text",
    }));
  if (options.length === 0) return null;
  return {
    from: before.from,
    options,
    filter: false,
    update: (_result, _from, _to, next) => wikiCompletions(next),
  };
}

/** 서브시퀀스 매칭 — "노트마" → "노트/마케팅" 매칭용. */
function fuzzy(query: string, text: string): boolean {
  const chars = [...query.normalize("NFC").toLowerCase()];
  let qi = 0;
  for (const ch of text.normalize("NFC").toLowerCase()) {
    if (qi < chars.length && ch === chars[qi]) qi++;
  }
  return qi === chars.length;
}

/** / 메뉴 아이콘 칸 — 슬래시 항목은 글리프 칩, 그 외 완성은 정렬 유지
 *  스페이서(addToOptions는 전체 완성 패널에 적용되므로 형별 분기). */
const slashIconSlot = {
  position: 10,
  render(completion: Completion) {
    const el = document.createElement("div");
    const sc = completion as import("./slashMenu").SlashCompletion;
    el.className = sc.slashIcon ? "md-slash-icon" : "md-slash-spacer";
    if (sc.slashIcon) el.textContent = sc.slashIcon;
    return el;
  },
};

/** / 메뉴 부제 — 항목 아래 한 줄 설명(Notion식 두 줄 행). */
const slashSubSlot = {
  position: 90,
  render(completion: Completion) {
    const sub = (completion as import("./slashMenu").SlashCompletion).slashSub;
    if (!sub) return null;
    const el = document.createElement("div");
    el.className = "md-slash-sub";
    el.textContent = sub;
    return el;
  },
};

export function wikiAutocompletion() {
  return [
    // Add our Markdown source alongside the native language sources. Let
    // CodeMirror retain each source's ranges, updates, snippets and async
    // cancellation instead of flattening them into a first-result adapter.
    EditorState.languageData.of(() => [{ autocomplete: combinedMatcher }]),
    // Native pointer/snippet application may dispatch directly, bypassing the
    // keyboard command's read-only guard if the document was locked meanwhile.
    EditorState.transactionFilter.of((tr) =>
      tr.startState.readOnly && tr.docChanged && tr.isUserEvent("input.complete") ? [] : tr),
    autocompletion({
      activateOnTyping: true,
      icons: false,
      closeOnBlur: true,
      addToOptions: [slashIconSlot, slashSubSlot],
    }),
  ];
}

/** Application Markdown candidates only; native language sources run independently. */
export function combinedMatcher(context: CompletionContext): CompletionResult | null {
  if (context.state.readOnly) return null;
  const literal = inLiteral(context.state, context.pos);
  if (literal) {
    return literal === "FencedCode" ? fenceLanguageCompletions(context) : null;
  }
  // Even without a matching document, a slash inside an unfinished wiki path
  // must not turn into a block insertion command.
  if (wikiPrefix(context)) return wikiCompletions(context);
  const slash = slashCompletions(context);
  if (slash) return slash;
  const cite = citeCompletions(context);
  if (cite) return cite;
  const tag = tagCompletions(context);
  if (tag) return tag;
  const fence = fenceLanguageCompletions(context);
  if (fence) return fence;
  return emojiCompletions(context);
}

/** "#pos" - workspace tag candidates (heading "#" excluded). */
function tagCompletions(context: CompletionContext): CompletionResult | null {
  if (enclosingNode(context.state, context.pos, tagExcludedNodes)) return null;
  const before = context.matchBefore(/#[\p{L}\p{N}_\-\/]*/u);
  if (!before) return null;
  const line = context.state.doc.lineAt(before.from);
  if (before.from > line.from && !/\s/.test(context.state.sliceDoc(before.from - 1, before.from))) return null;
  const typed = before.text.slice(1);
  if (typed.length === 0) return null;
  if (typed[0] === " ") return null;
  if (/^\p{N}/u.test(typed)) return null;
  const tags = tagsProvider();
  if (tags.length === 0) return null;
  const q = typed.toLowerCase();
  const options: Completion[] = tags
    .filter((t) => /^(?!\p{N})[\p{L}\p{N}_\-/]+$/u.test(t) && (!q || t.toLowerCase().includes(q)))
    .slice(0, 20)
    .map((t): Completion => ({
      label: t,
      apply: (view, _completion, from, to) => {
        if (view.state.readOnly || from < 0 || to < from || to > view.state.doc.length || inLiteral(view.state, to) || enclosingNode(view.state, to, tagExcludedNodes)) return;
        const line = view.state.doc.lineAt(from);
        if (from > line.from && !/\s/.test(view.state.sliceDoc(from - 1, from))) return;
        const query = view.state.sliceDoc(from, to);
        if (!/^#[\p{L}\p{N}_\-/]*$/u.test(query) || !tagsProvider().includes(t) ||
            !t.toLowerCase().includes(query.slice(1).toLowerCase())) return;
        const tail = /^[\p{L}\p{N}_\-/]*/u.exec(view.state.sliceDoc(to, view.state.doc.lineAt(to).to))![0];
        view.dispatch({ changes: { from, to: to + tail.length, insert: `#${t}` }, selection: { anchor: from + t.length + 1 },
          annotations: isolateHistory.of("full"), userEvent: "input.complete",
        });
      },
      type: "keyword",
    }));
  if (options.length === 0) return null;
  return {
    from: before.from,
    options,
    filter: false,
    update: (_result, _from, _to, next) => next.state.readOnly || inLiteral(next.state, next.pos) ? null : tagCompletions(next),
  };
}
