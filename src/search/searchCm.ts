// 문서 내 검색 — CM 하이라이트 장식 + 매칭 목록. UI 패널은 React(search/).
// 대소문자·정규식 지원, 현재 매치 강조, Enter/Shift+Enter 이동.

import { EditorState, Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
  regexp: boolean;
  /** 바꿀 내용(바꾸기 모드에서만). */
  replacement: string;
}

export interface SearchMatch {
  from: number;
  to: number;
}

interface SearchState {
  query: SearchQuery | null;
  matches: SearchMatch[];
  /** 현재 강조 매치 인덱스(matches 안). */
  current: number;
}

export const setSearchState = StateEffect.define<{
  query: SearchQuery | null;
  current?: number;
}>();

export const searchField = StateField.define<SearchState>({
  create: () => ({ query: null, matches: [], current: -1 }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setSearchState)) {
        if (e.value.query === null) {
          next = { query: null, matches: [], current: -1 };
        } else {
          const sameQuery =
            next.query !== null &&
            next.query.text === e.value.query.text &&
            next.query.caseSensitive === e.value.query.caseSensitive &&
            next.query.regexp === e.value.query.regexp;
          const matches = sameQuery
            ? next.matches
            : computeMatches(tr.state.doc.toString(), e.value.query);
          const current =
            e.value.current !== undefined
              ? e.value.current
              : Math.min(next.current, matches.length - 1);
          next = { query: e.value.query, matches, current };
        }
      }
    }
    // 문서가 바뀌면 매치 위치를 다시 계산한다.
    if (tr.docChanged && next.query) {
      const matches = computeMatches(tr.state.doc.toString(), next.query);
      next = {
        ...next,
        matches,
        current: Math.min(next.current, matches.length - 1),
      };
    }
    return next;
  },
});

const MAX_MATCHES = 5000;

export function computeMatches(text: string, query: SearchQuery): SearchMatch[] {
  if (!query.text) return [];
  const out: SearchMatch[] = [];
  try {
    if (query.regexp) {
      const re = new RegExp(
        query.text,
        query.caseSensitive ? "g" : "gi",
      );
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) && out.length < MAX_MATCHES) {
        out.push({ from: m.index, to: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++;
      }
    } else {
      const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
      const hay = query.caseSensitive ? text : text.toLowerCase();
      let i = 0;
      while ((i = hay.indexOf(needle, i)) !== -1 && out.length < MAX_MATCHES) {
        out.push({ from: i, to: i + needle.length });
        i += needle.length;
      }
    }
  } catch {
    return []; // 잘못된 정규식
  }
  return out;
}

const matchDeco = Decoration.mark({ class: "md-search-match" });
const currentDeco = Decoration.mark({ class: "md-search-match-current" });

const highlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchState)))) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const st = view.state.field(searchField);
      if (!st.query || st.matches.length === 0) return Decoration.none;
      const ranges: Range<Decoration>[] = [];
      for (let i = 0; i < st.matches.length; i++) {
        const m = st.matches[i];
        if (m.to < view.viewport.from || m.from > view.viewport.to) continue;
        ranges.push((i === st.current ? currentDeco : matchDeco).range(m.from, m.to));
      }
      return Decoration.set(ranges, true);
    }
  },
  { decorations: (v) => v.decorations },
);

export function searchHighlight() {
  return [searchField, highlightPlugin];
}

/** 현재 매치로 선택·스크롤. */
export function gotoMatch(view: EditorView, index: number): void {
  const st = view.state.field(searchField);
  if (!st.matches.length) return;
  const i = ((index % st.matches.length) + st.matches.length) % st.matches.length;
  view.dispatch({
    selection: { anchor: st.matches[i].from, head: st.matches[i].to },
    effects: setSearchState.of({ query: st.query, current: i }),
    scrollIntoView: true,
  });
}

/** 다음/이전 매치. */
export function findNext(view: EditorView, forward = true): void {
  const st = view.state.field(searchField);
  if (!st.matches.length) return;
  const from = view.state.selection.main.head;
  let next = st.matches.findIndex((m) => (forward ? m.from > from : m.to < from));
  if (next === -1) next = forward ? 0 : st.matches.length - 1;
  gotoMatch(view, next);
}

/** 닫기 — 하이라이트 제거. */
export function resetSearch(view: EditorView): void {
  view.dispatch({ effects: setSearchState.of({ query: null }) });
}

/** 현재 매치 하나 바꾸기. */
export function replaceCurrent(view: EditorView, query: SearchQuery): void {
  const st = view.state.field(searchField);
  const m = st.matches[st.current];
  if (!m || !query) return;
  view.dispatch({
    changes: { from: m.from, to: m.to, insert: query.replacement },
    // 문서 변경으로 매치가 재계산된다(searchField.update).
  });
  // 다음 매치로 이동.
  const updated = view.state.field(searchField);
  const next = updated.matches.findIndex((x) => x.from >= m.from);
  if (next !== -1) gotoMatch(view, next);
}

/** 모두 바꾸기 — 한 번의 변경 묶음으로(되돌리기 한 방). */
export function replaceAll(view: EditorView, query: SearchQuery): number {
  const st = view.state.field(searchField);
  if (!st.matches.length) return 0;
  const changes = st.matches.map((m) => ({
    from: m.from,
    to: m.to,
    insert: query.replacement,
  }));
  view.dispatch({ changes, userEvent: "input.replaceAll" });
  return changes.length;
}

export function searchStateOf(state: EditorState): SearchState {
  return state.field(searchField, false) ?? { query: null, matches: [], current: -1 };
}
