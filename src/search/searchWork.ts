import { computeMatches, MAX_MATCHES, replacementText, scanMatches, validSearchQuery, type SearchMatch, type SearchQuery } from "./searchMatches";

export type SearchFailure = "cancelled" | "timeout" | "unavailable" | "failed" | "too-large";
export class SearchWorkError extends Error {
  constructor(readonly code: SearchFailure) { super(code); this.name = "SearchWorkError"; }
}
export interface SearchEdit extends SearchMatch { insert: string }
export interface SearchNavigation extends SearchMatch { forward: boolean; includeCurrent?: boolean; strict?: boolean }
export interface SearchFindResult { kind: "find"; matches: SearchMatch[]; offset?: number; total?: number; index?: number }
export type SearchTask = { text: string; query: SearchQuery } & (
  { kind: "find"; navigation?: SearchNavigation } | { kind: "replace"; target?: SearchMatch }
);
export type SearchResult = SearchFindResult | { kind: "replace"; edits: SearchEdit[] };
export type SearchRequest = SearchTask & { id: number };
export type SearchResponse = { id: number } & ({ ok: true; result: SearchResult } | { ok: false; error: SearchFailure });

export function needsSearchWorker(query: SearchQuery, length: number): boolean {
  return query.regexp || length > 200_000 || query.text.length > 2000;
}
export function navigationAccepts(match: SearchMatch, navigation: SearchNavigation): boolean {
  const exact = match.from === navigation.from && match.to === navigation.to;
  const eligible = navigation.forward ? (navigation.strict ? match.from > navigation.to : match.from >= navigation.to) : match.to <= navigation.from;
  return eligible && (!exact || !!navigation.includeCurrent);
}

/** Keep only the first, current and chosen pages while counting the document.
 * Navigation is global even though highlights are limited to one result page. */
function navigationPage(text: string, query: SearchQuery, navigation: SearchNavigation): SearchFindResult {
  let page: SearchMatch[] = [], first: SearchMatch[] = [], total = 0;
  let chosen: { page: SearchMatch[]; index: number } | null = null;
  for (const { from, to } of scanMatches(text, query)) {
    if (total % MAX_MATCHES === 0) { page = []; if (total === 0) first = page; }
    page.push({ from, to });
    if (navigationAccepts({ from, to }, navigation) && (!navigation.forward || !chosen)) chosen = { page, index: total };
    total++;
  }
  if (!total) return { kind: "find", matches: [], offset: 0, total: 0, index: -1 };
  if (!chosen) chosen = navigation.forward ? { page: first, index: 0 } : { page, index: total - 1 };
  return { kind: "find", matches: chosen.page, offset: Math.floor(chosen.index / MAX_MATCHES) * MAX_MATCHES, total, index: chosen.index };
}

/** Shared worker algorithm. Never return a partial replacement plan on limits. */
export function performSearchTask(task: SearchTask): SearchResult {
  if (!validSearchQuery(task.query)) throw new SearchWorkError("failed");
  if (task.kind === "find") return task.navigation ? navigationPage(task.text, task.query, task.navigation) :
    { kind: "find", matches: computeMatches(task.text, task.query, MAX_MATCHES + 1) };
  const edits: SearchEdit[] = [];
  let inserted = 0;
  for (const found of scanMatches(task.text, task.query)) {
    if (task.target) {
      if (found.from > task.target.from) break;
      if (found.from !== task.target.from || found.to !== task.target.to) continue;
    }
    const insert = replacementText(task.query, found.match, task.text);
    inserted += insert.length;
    if (inserted > 32_000_000 || edits.length >= 500_000) throw new SearchWorkError("too-large");
    edits.push({ from: found.from, to: found.to, insert });
    if (task.target) break;
  }
  return { kind: "replace", edits };
}
