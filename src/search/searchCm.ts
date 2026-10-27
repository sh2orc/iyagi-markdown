// Document search: bounded highlights, original UTF-16 positions and atomic replacements.
import { ChangeSet, EditorState, Facet, Range, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";
import { computeMatches, MAX_MATCHES, sameSearch,
  validSearchQuery, type SearchMatch, type SearchQuery,
} from "./searchMatches";
import { createSearchWorker, SearchWorkerClient, type SearchWorkerPort } from "./searchWorkerClient";
import { navigationAccepts, needsSearchWorker, performSearchTask, SearchWorkError, type SearchEdit, type SearchFailure, type SearchFindResult, type SearchNavigation } from "./searchWork";
export { computeMatches, sameSearch, validSearchQuery } from "./searchMatches";
export type { SearchMatch, SearchQuery } from "./searchMatches";

interface SearchState {
  query: SearchQuery | null;
  matches: SearchMatch[];
  current: number;
  limited: boolean;
  pending: boolean;
  error: SearchFailure | null;
  revision: number;
  offset: number;
  total: number | null;
  navigation: SearchNavigation | null;
}
const emptyState = (): SearchState => ({ query: null, matches: [], current: -1, limited: false, pending: false,
  error: null, revision: 0, offset: 0, total: 0, navigation: null });

export const setSearchState = StateEffect.define<{ query: SearchQuery | null; current?: number; refresh?: boolean }>();
const searchResult = StateEffect.define<{ doc: Text; revision: number; result: SearchFindResult; error: SearchFailure | null }>();
const searchNavigation = StateEffect.define<SearchNavigation>();
export const searchWorkerFactory = Facet.define<() => SearchWorkerPort, () => SearchWorkerPort>({
  combine: (values) => values[0] ?? createSearchWorker,
});

export const searchField = StateField.define<SearchState>({
  create: emptyState,
  update(value, tr) {
    let query = value.query, requested: number | undefined, refresh = false;
    for (const effect of tr.effects) if (effect.is(setSearchState)) {
      query = effect.value.query;
      requested = effect.value.current;
      refresh ||= !!effect.value.refresh;
    }
    if (!query) return value.query ? { ...emptyState(), revision: value.revision + 1 } : value;
    let matches = value.matches, limited = value.limited;
    let pending = value.pending, error = value.error, revision = value.revision;
    let offset = value.offset, total = value.total, navigation = value.navigation;
    if (refresh || !sameSearch(query, value.query) || tr.docChanged) {
      revision++; error = null; offset = 0; total = null; navigation = null;
      pending = needsSearchWorker(query, tr.state.doc.length) && validSearchQuery(query);
      if (pending) { matches = []; limited = false; }
      else {
        const found = sameSearch(query, value.query) && tr.docChanged && !value.pending && !value.error && value.offset === 0
          ? updateMatchesForChanges(value.matches, tr.changes, tr.state.doc, query, MAX_MATCHES + 1)
          : computeMatches(tr.state.doc.toString(), query, MAX_MATCHES + 1);
        limited = found.length > MAX_MATCHES;
        matches = limited ? found.slice(0, MAX_MATCHES) : found;
        total = limited ? null : matches.length;
      }
    }
    for (const effect of tr.effects) if (effect.is(searchNavigation)) {
      revision++; pending = true; error = null; navigation = effect.value;
    }
    for (const effect of tr.effects) if (effect.is(searchResult) && effect.value.doc === tr.state.doc && effect.value.revision === revision) {
      const response = effect.value, result = response.result;
      pending = false; error = response.error; navigation = null;
      offset = result.offset ?? 0;
      matches = result.matches.slice(0, MAX_MATCHES);
      total = response.error ? null : result.total ?? (result.matches.length > MAX_MATCHES ? null : matches.length);
      limited = offset > 0 || total === null && result.matches.length > MAX_MATCHES || total !== null && total > matches.length;
    }
    const selection = tr.state.selection.main;
    const selected = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
    const current = requested === undefined ? selected : Math.max(-1, Math.min(requested, matches.length - 1));
    return query === value.query && matches === value.matches && current === value.current && limited === value.limited &&
        pending === value.pending && error === value.error && revision === value.revision && offset === value.offset &&
        total === value.total && navigation === value.navigation
      ? value : { query, matches, current, limited, pending, error, revision, offset, total, navigation };
  },
});

/** Keep the unaffected prefix, then scan the suffix from a known match boundary.
 * A fixed local window is insufficient: inserting one "a" into "aaaa..." changes
 * every non-overlapping "aa" match after it. Capped results also need replenishing. */
export function updateMatchesForChanges(
  matches: SearchMatch[], changes: ChangeSet, doc: Text, query: SearchQuery, limit = MAX_MATCHES,
): SearchMatch[] {
  if (!query.text) return [];
  if (query.regexp || query.wholeWord) return computeMatches(doc.toString(), query, limit);
  let first = changes.length;
  changes.iterChangedRanges((from) => { first = Math.min(first, from); });
  const safeEnd = Math.max(0, first - query.text.length);
  const kept = matches.filter((match) => match.to <= safeEnd).slice(0, limit);
  if (kept.length >= limit) return kept;
  const from = kept.length ? changes.mapPos(kept[kept.length - 1].to, -1) : 0;
  return kept.concat(computeMatches(doc.sliceString(from), query, limit - kept.length)
    .map((match) => ({ from: match.from + from, to: match.to + from })));
}

const searchListeners = new WeakMap<EditorView, Set<() => void>>();
export function subscribeSearch(view: EditorView, listener: () => void): () => void {
  let listeners = searchListeners.get(view);
  if (!listeners) { listeners = new Set(); searchListeners.set(view, listeners); }
  listeners.add(listener);
  const current = listeners;
  return () => { current.delete(listener); if (!current.size) searchListeners.delete(view); };
}
type SearchJump = { kind: "index"; index: number } | { kind: "next"; forward: boolean } |
  { kind: "after"; from: number; exclusive: boolean } | { kind: "navigation" };
function jumpIndex(matches: SearchMatch[], jump: Exclude<SearchJump, { kind: "navigation" }>, view: EditorView): number {
  if (jump.kind === "index") return ((jump.index % matches.length) + matches.length) % matches.length;
  if (jump.kind === "after") {
    const next = matches.findIndex((match) => jump.exclusive ? match.from > jump.from : match.from >= jump.from);
    return next < 0 ? 0 : next;
  }
  const selection = view.state.selection.main;
  const selected = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
  if (selected >= 0) return (selected + (jump.forward ? 1 : -1) + matches.length) % matches.length;
  if (jump.forward) {
    const next = matches.findIndex((match) => match.from >= selection.to);
    return next < 0 ? 0 : next;
  }
  let previous = matches.length - 1;
  while (previous >= 0 && matches[previous].to > selection.from) previous--;
  return previous < 0 ? matches.length - 1 : previous;
}

function pageContainsNavigation(page: Pick<SearchState, "matches" | "offset" | "total" | "limited">, navigation: SearchNavigation): boolean {
  if (!page.limited) return true;
  const first = page.matches[0], last = page.matches.at(-1);
  if (!first || !last) return false;
  if (navigation.forward && navigation.to < first.from && page.offset > 0) return false;
  if (!navigation.forward && navigation.from >= last.to && (page.total === null || page.offset + page.matches.length < page.total)) return false;
  return page.matches.some((match) => navigationAccepts(match, navigation));
}
function navigationFor(jump: { kind: "next"; forward: boolean } | { kind: "after"; from: number; exclusive: boolean }, view: EditorView): SearchNavigation {
  if (jump.kind === "after") return { from: jump.from, to: jump.from, forward: true, includeCurrent: true, strict: jump.exclusive };
  const { from, to } = view.state.selection.main;
  return { from, to, forward: jump.forward };
}
function requestNavigation(view: EditorView, navigation: SearchNavigation): void {
  const state = searchStateOf(view.state), plugin = view.plugin(searchWorkPlugin);
  if (!plugin) return;
  const old = state.navigation;
  if (!state.pending || !old || old.from !== navigation.from || old.to !== navigation.to || old.forward !== navigation.forward ||
      old.includeCurrent !== navigation.includeCurrent || old.strict !== navigation.strict) {
    view.dispatch({ effects: searchNavigation.of(navigation) });
  }
  plugin.queueJump({ kind: "navigation" });
}

const searchWorkPlugin = ViewPlugin.fromClass(class {
  private client: SearchWorkerClient;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private planSerial = 0;
  private planning = false;
  private destroyed = false;
  private jump: SearchJump | null = null;
  constructor(private view: EditorView) {
    this.client = new SearchWorkerClient(view.state.facet(searchWorkerFactory));
    this.schedule();
  }
  update(update: ViewUpdate) {
    const before = searchStateOf(update.startState), after = searchStateOf(update.state);
    if (update.selectionSet) this.jump = null;
    if (update.docChanged || before.revision !== after.revision ||
        this.planning && update.startState.readOnly !== update.state.readOnly) {
      this.generation++; this.clearTimer(); this.jump = null; this.client.cancel();
      if (!after.query) this.client.dispose();
      this.schedule();
    }
    if (before !== after) for (const listener of searchListeners.get(this.view) ?? []) listener();
  }
  queueJump(jump: SearchJump) { this.jump = jump; }
  async replacement(query: SearchQuery, target?: SearchMatch): Promise<SearchEdit[]> {
    this.clearTimer(); this.generation++; this.jump = null;
    const serial = ++this.planSerial;
    this.planning = true;
    try {
      const result = await this.client.run({ kind: "replace", text: this.view.state.doc.toString(), query, target });
      if (result.kind !== "replace") throw new SearchWorkError("failed");
      return result.edits;
    } finally {
      if (serial === this.planSerial) { this.planning = false; this.schedule(); }
    }
  }
  private clearTimer() { if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  private schedule() {
    if (this.destroyed || this.planning || !searchStateOf(this.view.state).pending) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      const state = searchStateOf(this.view.state), doc = this.view.state.doc;
      if (!state.pending || !state.query) return;
      const generation = ++this.generation;
      const publish = (result: SearchFindResult, error: SearchFailure | null) => {
        if (this.destroyed || generation !== this.generation || this.view.state.doc !== doc ||
            searchStateOf(this.view.state).revision !== state.revision) return;
        const jump = this.jump; this.jump = null;
        const visible = result.matches.slice(0, MAX_MATCHES), offset = result.offset ?? 0;
        const total = result.total ?? (result.matches.length > MAX_MATCHES ? null : visible.length);
        const page = { matches: visible, offset, total, limited: offset > 0 || total === null || total > visible.length };
        let target: SearchMatch | null = null, follow: SearchNavigation | null = null;
        if (jump && visible.length && !error) {
          if (jump.kind === "navigation") target = visible[(result.index ?? offset) - offset] ?? null;
          else if (jump.kind === "index") {
            if (jump.index < 0 && page.limited) follow = { from: 0, to: 0, forward: false };
            else target = visible[jumpIndex(visible, jump, this.view)];
          } else {
            const navigation = navigationFor(jump, this.view);
            if (!pageContainsNavigation(page, navigation)) follow = navigation;
            else target = visible[jumpIndex(visible, jump, this.view)];
          }
        }
        this.view.dispatch({ effects: searchResult.of({ doc, revision: state.revision, result, error }),
          ...(target ? { selection: { anchor: target.from, head: target.to }, scrollIntoView: true } : {}),
        });
        if (follow) requestNavigation(this.view, follow);
      };
      void this.client.run({ kind: "find", text: doc.toString(), query: state.query, navigation: state.navigation ?? undefined }).then((result) => {
        if (result.kind === "find") publish(result, null);
      }, (error: unknown) => {
        if (error instanceof SearchWorkError && error.code === "cancelled") return;
        publish({ kind: "find", matches: [] }, error instanceof SearchWorkError ? error.code : "failed");
      });
    }, 60);
  }
  destroy() { this.destroyed = true; this.generation++; this.clearTimer(); this.client.dispose(); }
});

const matchDeco = Decoration.mark({ class: "md-search-match" });
const currentDeco = Decoration.mark({ class: "md-search-match-current" });
const highlightPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate) {
    if (update.viewportChanged || update.startState.field(searchField) !== update.state.field(searchField)) {
      this.decorations = this.build(update.view);
    }
  }
  build(view: EditorView): DecorationSet {
    const state = view.state.field(searchField);
    const ranges: Range<Decoration>[] = [];
    for (let i = 0; i < state.matches.length; i++) {
      const match = state.matches[i];
      // Empty regex results are navigable insertion points, not mark ranges.
      if (match.from === match.to || match.to < view.viewport.from || match.from > view.viewport.to) continue;
      ranges.push((i === state.current ? currentDeco : matchDeco).range(match.from, match.to));
    }
    return Decoration.set(ranges, true);
  }
}, { decorations: (plugin) => plugin.decorations });

export function searchHighlight() { return [searchField, searchWorkPlugin, highlightPlugin]; }

export function gotoMatch(view: EditorView, index: number): void {
  const state = searchStateOf(view.state);
  if (state.pending) { view.plugin(searchWorkPlugin)?.queueJump({ kind: "index", index }); return; }
  if (!state.matches.length) return;
  if (index < 0 && state.limited) { requestNavigation(view, { from: 0, to: 0, forward: false }); return; }
  const i = ((index % state.matches.length) + state.matches.length) % state.matches.length;
  view.dispatch({
    selection: { anchor: state.matches[i].from, head: state.matches[i].to },
    effects: setSearchState.of({ query: state.query, current: i }), scrollIntoView: true,
  });
}

export function findNext(view: EditorView, forward = true): void {
  const state = searchStateOf(view.state);
  const navigation = navigationFor({ kind: "next", forward }, view);
  if (state.pending && state.navigation) { requestNavigation(view, navigation); return; }
  if (state.pending) { view.plugin(searchWorkPlugin)?.queueJump({ kind: "next", forward }); return; }
  if (!state.matches.length) return;
  if (!pageContainsNavigation(state, navigation)) { requestNavigation(view, navigation); return; }
  gotoMatch(view, jumpIndex(state.matches, { kind: "next", forward }, view));
}

export function resetSearch(view: EditorView): void {
  view.dispatch({ effects: setSearchState.of({ query: null }) });
}

async function replacementEdits(view: EditorView, query: SearchQuery, target?: SearchMatch): Promise<SearchEdit[]> {
  const length = view.state.doc.length;
  if (needsSearchWorker(query, length) || length * (query.replacement?.length ?? 0) > 1_000_000) {
    const plugin = view.plugin(searchWorkPlugin);
    if (!plugin) throw new SearchWorkError("unavailable");
    return plugin.replacement(query, target);
  }
  const result = performSearchTask({ kind: "replace", text: view.state.doc.toString(), query, target });
  return result.kind === "replace" ? result.edits : [];
}

export async function replaceCurrent(view: EditorView, query: SearchQuery, isCurrent: () => boolean = () => true): Promise<boolean> {
  const state = searchStateOf(view.state), doc = view.state.doc, selection = view.state.selection;
  if (view.state.readOnly || !sameSearch(state.query, query) || !validSearchQuery(query)) return false;
  const target = state.matches.find((match) => match.from === selection.main.from && match.to === selection.main.to);
  if (!target) { findNext(view); return false; }
  const edits = await replacementEdits(view, { ...query }, target);
  if (!edits.length || !isCurrent() || view.state.doc !== doc || view.state.readOnly || !view.state.selection.eq(selection) ||
      !sameSearch(searchStateOf(view.state).query, query)) return false;
  const changes = view.state.changes(edits);
  const expected = changes.apply(doc);
  const end = target.to + changes.newLength - changes.length;
  view.dispatch({ changes, selection: { anchor: end }, annotations: isolateHistory.of("full"), userEvent: "input.replace" });
  if (!view.state.doc.eq(expected)) return false;
  const updated = searchStateOf(view.state);
  const jump: SearchJump = { kind: "after", from: end, exclusive: target.from === target.to };
  if (updated.pending) view.plugin(searchWorkPlugin)?.queueJump(jump);
  else if (updated.matches.length) {
    const navigation = navigationFor(jump, view);
    if (!pageContainsNavigation(updated, navigation)) requestNavigation(view, navigation);
    else gotoMatch(view, jumpIndex(updated.matches, jump, view));
  }
  return true;
}

export interface ReplaceAllPlan {
  readonly doc: Text;
  readonly query: SearchQuery;
  readonly changes: ChangeSet;
  readonly count: number;
}
/** Count and prepare every match before confirmation, independently of the highlight cap. */
export async function prepareReplaceAll(view: EditorView, query: SearchQuery): Promise<ReplaceAllPlan | null> {
  if (view.state.readOnly || !sameSearch(searchStateOf(view.state).query, query) || !validSearchQuery(query)) return null;
  const doc = view.state.doc, snapshot = { ...query };
  const edits = await replacementEdits(view, snapshot);
  if (view.state.doc !== doc || view.state.readOnly || !sameSearch(searchStateOf(view.state).query, snapshot)) return null;
  return edits.length ? { doc, query: snapshot, changes: view.state.changes(edits), count: edits.length } : null;
}
export function applyReplaceAll(view: EditorView, plan: ReplaceAllPlan): number {
  if (view.state.readOnly || view.state.doc !== plan.doc || !sameSearch(searchStateOf(view.state).query, plan.query)) return 0;
  const expected = plan.changes.apply(plan.doc);
  view.dispatch({ changes: plan.changes, annotations: isolateHistory.of("full"), userEvent: "input.replaceAll" });
  return view.state.doc.eq(expected) ? plan.count : 0;
}
export async function replaceAll(view: EditorView, query: SearchQuery): Promise<number> {
  const plan = await prepareReplaceAll(view, query);
  return plan ? applyReplaceAll(view, plan) : 0;
}
export function searchStateOf(state: EditorState): SearchState { return state.field(searchField, false) ?? emptyState(); }

/** 결과 줄을 매치 강조 조각으로 나눈다(전체 검색 패널 표시용).
 *  대소문자무시 부분문자열 — Rust search_tree와 같은 규칙. 순수 함수. */
export function splitHighlights(
  line: string,
  needle: string,
  caseSensitive = false,
): Array<{ text: string; hit: boolean }> {
  const q = Array.from(needle.trim());
  if (!q.length) return [{ text: line, hit: false }];
  const chars = Array.from(line);
  const offsets = [0];
  for (const char of chars) offsets.push(offsets[offsets.length - 1] + char.length);
  const out: Array<{ text: string; hit: boolean }> = [];
  let from = 0;
  for (let i = 0; i + q.length <= chars.length;) {
    const matches = q.every((char, j) => caseSensitive ? chars[i + j] === char
      : chars[i + j].toLowerCase() === char.toLowerCase());
    if (!matches) { i += 1; continue; }
    const at = offsets[i];
    const end = offsets[i + q.length];
    if (at > from) out.push({ text: line.slice(from, at), hit: false });
    out.push({ text: line.slice(at, end), hit: true });
    from = end;
    i += q.length;
  }
  if (from < line.length) out.push({ text: line.slice(from), hit: false });
  return out;
}
