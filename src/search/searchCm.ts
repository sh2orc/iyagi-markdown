// 문서 내 검색 — CM 하이라이트 장식 + 매칭 목록. UI 패널은 React(search/).
// 대소문자·정규식 지원, 현재 매치 강조, Enter/Shift+Enter 이동.

import { ChangeSet, EditorState, Range, StateEffect, StateField, type Text } from "@codemirror/state";
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
    // 문서가 바뀌면 매치를 증분 갱신한다 — 일반 텍스트 검색은 변경 영역
    // 주변만 다시 훑고 나머지 매치는 좌표만 옮긴다(편집 한 번이 O(문서)
    // 재스캔이 되지 않게). 정규식은 전역 상태(lookbehind 등) 때문에 전체 재스캔.
    if (tr.docChanged && next.query) {
      const matches = next.query.regexp
        ? computeMatches(tr.state.doc.toString(), next.query)
        : updateMatchesForChanges(next.matches, tr.changes, tr.state.doc, next.query);
      next = {
        ...next,
        matches,
        current: Math.min(next.current, matches.length - 1),
      };
    }
    return next;
  },
});

/** 편집 델타로 매치 증분 갱신: 살아남은 매치는 mapPos으로 시프트하고,
 *  변경 영역 ±(검색어 길이-1) 창만 다시 스캔해 새 매치를 합친다. */
export function updateMatchesForChanges(
  matches: SearchMatch[],
  changes: ChangeSet,
  doc: Text,
  query: SearchQuery,
): SearchMatch[] {
  if (!query.text) return [];
  const needle = query.caseSensitive ? query.text : query.text.toLowerCase();
  const pad = needle.length - 1;
  // 재스캔 창(새 문서 좌표) — 오름차순 병합.
  const windows: Array<{ from: number; to: number }> = [];
  const oldRanges: Array<[number, number]> = [];
  changes.iterChanges((fromA, toA, fromB, toB) => {
    oldRanges.push([fromA, toA]);
    const from = Math.max(0, fromB - pad);
    const to = Math.min(doc.length, toB + pad);
    const last = windows[windows.length - 1];
    if (last && from <= last.to) last.to = Math.max(last.to, to);
    else windows.push({ from, to });
  });
  // 살아남은 매치: 변경 전 좌표에서 내부를 건드린(삽입이 아닌) 매치는 제거하고,
  // 나머지는 시프트(경계 삽입은 흡수하지 않게 assoc -1).
  const kept: SearchMatch[] = [];
  for (const m of matches) {
    if (oldRanges.some(([a, b]) => a < m.to && b > m.from)) continue; // 내용 침범
    // 시작은 삽입 뒤로(텍스트가 밀린다), 끝은 삽입 앞으로(흡수하지 않는다).
    const from = changes.mapPos(m.from, 1);
    const to = changes.mapPos(m.to, -1);
    if (to <= from) continue; // 매칭 텍스트가 통째로 사라졌다
    kept.push({ from, to });
  }
  // 창 안에서 새 매치 수집 + 병합 정렬(중복 제거).
  const out: SearchMatch[] = [];
  let ki = 0;
  for (const w of windows) {
    const hay = query.caseSensitive
      ? doc.sliceString(w.from, w.to)
      : doc.sliceString(w.from, w.to).toLowerCase();
    let i = 0;
    while (i <= hay.length - needle.length) {
      const hit = hay.indexOf(needle, i);
      if (hit === -1) break;
      const nm = { from: w.from + hit, to: w.from + hit + needle.length };
      while (ki < kept.length && kept[ki].from < nm.from) {
        const k = kept[ki++];
        if (out.length === 0 || out[out.length - 1].from !== k.from) out.push(k);
      }
      const last = out[out.length - 1];
      const dup = last != null && last.from === nm.from && last.to === nm.to;
      if (!dup && out.length < MAX_MATCHES) out.push(nm);
      i = hit + needle.length;
    }
  }
  while (ki < kept.length) {
    const k = kept[ki++];
    if (out.length === 0 || out[out.length - 1].from !== k.from) out.push(k);
  }
  return out.length > MAX_MATCHES ? out.slice(0, MAX_MATCHES) : out;
}

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

/** 결과 줄을 매치 강조 조각으로 나눈다(전체 검색 패널 표시용).
 *  대소문자무시 부분문자열 — Rust search_tree와 같은 규칙. 순수 함수. */
export function splitHighlights(
  line: string,
  needle: string,
): Array<{ text: string; hit: boolean }> {
  const q = needle.trim().toLowerCase();
  if (!q) return [{ text: line, hit: false }];
  const hay = line.toLowerCase();
  const out: Array<{ text: string; hit: boolean }> = [];
  let i = 0;
  for (;;) {
    const at = hay.indexOf(q, i);
    if (at === -1) break;
    if (at > i) out.push({ text: line.slice(i, at), hit: false });
    out.push({ text: line.slice(at, at + q.length), hit: true });
    i = at + q.length;
  }
  if (i < line.length) out.push({ text: line.slice(i), hit: false });
  return out;
}
