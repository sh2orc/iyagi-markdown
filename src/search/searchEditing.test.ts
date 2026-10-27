// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { applyReplaceAll, computeMatches, findNext, gotoMatch, prepareReplaceAll, replaceAll, replaceCurrent,
  searchHighlight, searchStateOf, searchWorkerFactory, setSearchState, updateMatchesForChanges, type SearchQuery,
} from "./searchCm";
import { InlineSearchWorker } from "./searchWorkerTestUtils";

const query = (text: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({ text, caseSensitive: false, regexp: false, ...extra });
const views: EditorView[] = [];
beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
});
function mount(doc: string, q: SearchQuery) {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc,
    extensions: [searchHighlight(), history(), searchWorkerFactory.of(() => new InlineSearchWorker())],
  }) });
  views.push(view);
  view.dispatch({ effects: setSearchState.of({ query: q }) });
  return view;
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { for (const view of views.splice(0)) view.destroy(); vi.clearAllTimers(); vi.useRealTimers(); });

it("대소문자 변환이 길어지는 글자 뒤에서도 원문의 범위를 가리킨다", async () => {
  const text = "İ😀 X x";
  const matches = computeMatches(text, query("x"));
  expect(matches).toEqual([{ from: 4, to: 5 }, { from: 6, to: 7 }]);
  expect(matches.map((match) => text.slice(match.from, match.to))).toEqual(["X", "x"]);
  const view = mount(text, query("x", { replacement: "Y" }));
  expect(await replaceAll(view, query("x", { replacement: "Y" }))).toBe(2);
  expect(view.state.doc.toString()).toBe("İ😀 Y Y");
});

it("인접 매치와 세 개 이상의 결과를 앞뒤로 건너뛰지 않는다", () => {
  const view = mount("aaaa", query("a"));
  gotoMatch(view, 0);
  for (const expected of [1, 2, 3, 0]) { findNext(view); expect(view.state.selection.main.from).toBe(expected); }
  for (const expected of [3, 2, 1, 0]) { findNext(view, false); expect(view.state.selection.main.from).toBe(expected); }
});

it("빈 문자열 정규식은 장식 오류 없이 Unicode 경계로 진행한다", async () => {
  const q = query("(?=)", { regexp: true, replacement: "|" });
  const view = mount("😀a", q);
  await vi.advanceTimersByTimeAsync(60);
  expect(searchStateOf(view.state).matches).toEqual([{ from: 0, to: 0 }, { from: 2, to: 2 }, { from: 3, to: 3 }]);
  expect(await replaceAll(view, q)).toBe(3);
  expect(view.state.doc.toString()).toBe("|😀|a|");
});

it("연속 중첩 검색어의 편집 뒤 결과도 비중첩 전체 검색과 일치한다", () => {
  const q = query("aa"), view = mount("aaaaaaaa", q);
  const before = searchStateOf(view.state).matches;
  const transaction = view.state.update({ changes: { from: 1, insert: "a" } });
  expect(updateMatchesForChanges(before, transaction.changes, transaction.state.doc, q))
    .toEqual(computeMatches(transaction.state.doc.toString(), q));
  view.dispatch(transaction);
  expect(searchStateOf(view.state).matches).toEqual([{ from: 0, to: 2 }, { from: 2, to: 4 }, { from: 4, to: 6 }, { from: 6, to: 8 }]);
});

it("쿼리와 문서를 한 트랜잭션에서 바꿀 때 좌표를 두 번 이동하지 않는다", () => {
  const view = mount("old X", query("old"));
  view.dispatch({ changes: { from: 0, insert: "prefix " }, effects: setSearchState.of({ query: query("X") }) });
  // caseSensitive: false — "prefix"의 x(5)와 원본 X(11) 둘 다 매치.
  // 핵심은 좌표가 새로 계산된다는 것(구 "old" 매치의 이동 좌표가 아님).
  expect(searchStateOf(view.state).matches).toEqual([{ from: 5, to: 6 }, { from: 11, to: 12 }]);
});

it("표시 상한 뒤 결과도 모두 바꾸고 한 번에 실행 취소한다", async () => {
  const q = query("a", { replacement: "b" }), source = "a ".repeat(5010);
  const view = mount(source, q);
  expect(searchStateOf(view.state).matches).toHaveLength(5000);
  expect(searchStateOf(view.state).limited).toBe(true);
  const plan = (await prepareReplaceAll(view, q))!;
  expect(plan.count).toBe(5010);
  expect(applyReplaceAll(view, plan)).toBe(5010);
  expect(view.state.doc.toString()).toBe("b ".repeat(5010));
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(source);
});

it("앞쪽 매치 삭제 후 표시 상한 밖 결과를 보충한다", () => {
  const view = mount("a ".repeat(5001), query("a"));
  view.dispatch({ changes: { from: 0, to: 2 } });
  expect(searchStateOf(view.state).matches).toHaveLength(5000);
  expect(searchStateOf(view.state).limited).toBe(false);
  expect(searchStateOf(view.state).matches.at(-1)).toEqual({ from: 9998, to: 9999 });
});

it("정규식 캡처·이름 그룹·전체 일치와 달러 치환을 적용한다", async () => {
  const q = query("(?<word>[a-z]+)-(\\d+)", { regexp: true, replacement: "$<word>:$2:$$:$&:$12" });
  const view = mount("item-12 other-3", q);
  expect(await replaceAll(view, q)).toBe(2);
  expect(view.state.doc.toString()).toBe("item:12:$:item-12:item2 other:3:$:other-3:other2");
});

it("일반 문자열 바꾸기는 달러 표기를 그대로 넣고 한 번만 되돌린다", async () => {
  const q = query("a", { replacement: "$1" }), view = mount("a a", q);
  gotoMatch(view, 0);
  expect(await replaceCurrent(view, q)).toBe(true);
  expect(view.state.doc.toString()).toBe("$1 a");
  expect(view.state.selection.main.from).toBe(3);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("a a");
});

it.each(["doc", "query", "readonly", "filter"])("%s 변경·거절 후에는 확인 전 계획을 적용하지 않는다", async (cause) => {
  const q = query("a", { replacement: "b" }), view = mount("a a", q);
  const plan = (await prepareReplaceAll(view, q))!;
  if (cause === "doc") view.dispatch({ changes: { from: 0, insert: "a " } });
  else if (cause === "query") view.dispatch({ effects: setSearchState.of({ query: query("other") }) });
  else if (cause === "readonly") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  else view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
  const before = view.state.doc;
  expect(applyReplaceAll(view, plan)).toBe(0);
  expect(view.state.doc).toBe(before);
});

it("오래된 검색 조건과 읽기 전용 상태에서 단일 바꾸기도 거절한다", async () => {
  const q = query("a", { replacement: "b" }), view = mount("a a", q);
  gotoMatch(view, 0);
  expect(await replaceCurrent(view, query("x", { replacement: "b" }))).toBe(false);
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
  expect(await replaceCurrent(view, q)).toBe(false);
  expect(view.state.doc.toString()).toBe("a a");
});
