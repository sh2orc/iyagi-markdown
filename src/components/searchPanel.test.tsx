// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history } from "@codemirror/commands";
import type { AppStore } from "../app/store";
import { makeT } from "../i18n";
import { searchHighlight, searchStateOf, searchWorkerFactory } from "../search/searchCm";
import { InlineSearchWorker } from "../search/searchWorkerTestUtils";
import type { SearchWorkerPort } from "../search/searchWorkerClient";
import { SearchPanel } from "./SearchPanel";

const { ask } = vi.hoisted(() => ({ ask: vi.fn<() => Promise<boolean>>() }));
vi.mock("../api", () => ({ askDialog: ask }));
const t = makeT("en");
beforeAll(() => {
  if (!Range.prototype.getClientRects) Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  if (!Range.prototype.getBoundingClientRect) Range.prototype.getBoundingClientRect = () => new DOMRect();
});
let host: HTMLDivElement, editorHost: HTMLDivElement, root: Root, view: EditorView;
let opened: boolean;
let store: ReturnType<typeof makeStore>;
const stateOf = (doc: string, create: () => SearchWorkerPort = () => new InlineSearchWorker()) => EditorState.create({
  doc, extensions: [searchHighlight(), history(), searchWorkerFactory.of(create)],
});
function makeStore() {
  return { view, active: { id: "first" },
    state: { settings: { searchQuery: "", searchCase: false, searchRegex: false, searchWord: false } },
    persistSettings: vi.fn(), toast: vi.fn(),
    setSearchOpen: vi.fn((value: boolean) => { opened = value; render(); }),
  };
}
function render() { root.render(<SearchPanel store={store as unknown as AppStore} view={view} t={t} open={opened} />); }
function mount(doc = "alpha beta alpha", create?: () => SearchWorkerPort) {
  view = new EditorView({ parent: editorHost, state: stateOf(doc, create) });
  store = makeStore(); opened = true;
  act(render);
}
function input(index = 0) { return host.querySelectorAll<HTMLInputElement>("input")[index]; }
function type(value: string, index = 0) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(index), value);
    input(index).dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent?.startsWith(label))!;
}
function click(label: string) { act(() => button(label).click()); }
function key(value: string, isComposing = false, shiftKey = false) {
  act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: value, isComposing, shiftKey, bubbles: true, cancelable: true })));
}
async function waitSearch() { await act(async () => { await vi.advanceTimersByTimeAsync(150); }); }
async function readyReplace() { type("alpha"); await waitSearch(); click(t.replacePlaceholder); type("omega", 1); }
beforeEach(() => {
  vi.useFakeTimers(); ask.mockReset(); ask.mockResolvedValue(true);
  host = document.createElement("div"); editorHost = document.createElement("div");
  document.body.append(host, editorHost); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); view?.destroy(); host.remove(); editorHost.remove();
  vi.clearAllTimers(); vi.useRealTimers();
});

it("Enter는 보류 검색을 즉시 적용한 뒤 다음 Enter부터 이동한다", async () => {
  mount(); type("alpha"); key("Enter");
  expect(searchStateOf(view.state).matches).toHaveLength(2);
  expect(view.state.selection.main.from).toBe(0);
  await waitSearch(); key("Enter");
  expect(view.state.selection.main.from).toBe(11);
  key("Enter", false, true);
  expect(view.state.selection.main.from).toBe(0);
});

it.each(["clear", "close", "invalid"])("%s 뒤 예약 검색이 이전 결과를 되살리지 않는다", async (cause) => {
  mount();
  if (cause === "invalid") click(t.findRegex);
  type("alpha");
  if (cause === "clear") type("");
  else if (cause === "close") click(t.close);
  else type("[");
  await waitSearch();
  expect(searchStateOf(view.state).query).toBeNull();
  if (cause === "clear") expect(store.persistSettings).toHaveBeenLastCalledWith({ searchQuery: "" });
  if (cause === "invalid") {
    expect(input().getAttribute("aria-invalid")).toBe("true");
    click(t.findRegex); await waitSearch();
    expect(input().getAttribute("aria-invalid")).toBe("false");
    expect(searchStateOf(view.state).query?.text).toBe("[");
  }
});

it("같은 편집기를 재사용하는 탭 전환에서도 현재 검색을 새 문서에 적용한다", async () => {
  mount(); type("alpha");
  act(() => { store.active = { id: "second" }; view.setState(stateOf("prefix alpha")); render(); });
  await waitSearch();
  expect(searchStateOf(view.state).matches).toEqual([{ from: 7, to: 12 }]);
  expect(view.state.selection.main.from).toBe(7);
});

it("IME 조합 중 Enter·Escape는 검색 확정이나 닫기를 실행하지 않는다", () => {
  mount(); type("alpha"); key("Enter", true); key("Escape", true);
  expect(searchStateOf(view.state).query).toBeNull();
  expect(store.setSearchOpen).not.toHaveBeenCalled();
});

it.each(["tab", "edit", "readonly", "close", "filter"])("확인 대기 중 %s 변경 후에는 바꾸지 않고 성공을 알리지 않는다", async (cause) => {
  mount(); await readyReplace();
  let resolve!: (value: boolean) => void;
  ask.mockImplementation(() => new Promise((done) => { resolve = done; }));
  await act(async () => { button(t.findReplaceAll).click(); button(t.findReplaceAll).click(); });
  expect(ask).toHaveBeenCalledTimes(1);
  act(() => {
    if (cause === "tab") { store.active = { id: "second" }; view.setState(stateOf("alpha elsewhere")); render(); }
    else if (cause === "edit") view.dispatch({ changes: { from: 0, insert: "prefix " } });
    else if (cause === "readonly") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    else if (cause === "close") button(t.close).click();
    else view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
  });
  const before = view.state.doc;
  await act(async () => { resolve(true); });
  expect(view.state.doc).toBe(before);
  expect(store.toast).not.toHaveBeenCalled();
  expect(input().value).toBe("alpha");
  expect(input(1).value).toBe("omega");
});

it("전체 건수를 확인하고 일괄 바꾸며 확인 실패는 입력을 유지한다", async () => {
  mount("alpha ".repeat(5001)); await readyReplace();
  ask.mockRejectedValueOnce(new Error("dialog unavailable"));
  await act(async () => { button(t.findReplaceAll).click(); });
  expect(host.textContent).toContain(t.searchReplaceFailed);
  expect(view.state.doc.toString()).toBe("alpha ".repeat(5001));
  await act(async () => { button(t.findReplaceAll).click(); });
  expect(ask).toHaveBeenLastCalledWith(t.f.replaceAllConfirm(5001));
  expect(view.state.doc.toString()).toBe("omega ".repeat(5001));
  expect(store.toast).toHaveBeenCalledWith(t.f.replaced(5001));
});

it("비동기 검색 완료를 구독해 상태와 개수를 갱신하고 정규식 바꾸기를 적용한다", async () => {
  mount("a1 a2"); click(t.findRegex); type("\\d+"); key("Enter");
  expect(host.textContent).toContain(t.searchSearching);
  await waitSearch();
  expect(host.textContent).toContain(t.f.findCount(1, 2));
  click(t.replacePlaceholder); type("[$&]", 1);
  await act(async () => { button(t.findReplaceAll).click(); });
  expect(view.state.doc.toString()).toBe("a[1] a[2]");
  expect(store.toast).toHaveBeenCalledWith(t.f.replaced(2));
});

it("작업자 실패를 보여 주고 Enter 재시도 후에는 오류와 검색 중 상태를 지운다", async () => {
  let available = false;
  mount("alpha beta alpha", () => {
    if (!available) throw new Error("unavailable");
    return new InlineSearchWorker();
  });
  click(t.findRegex); type("alpha"); key("Enter");
  await waitSearch();
  expect(host.textContent).toContain(t.searchWorkerUnavailable);
  expect(host.textContent).toContain(t.searchStopped);
  available = true; key("Enter"); await waitSearch();
  expect(host.textContent).not.toContain(t.searchWorkerUnavailable);
  expect(host.textContent).toContain(t.f.findCount(1, 2));
});

it("표시 상한을 넘어 이동하면 전체 순번과 정확한 총 건수를 표시한다", async () => {
  mount("alpha ".repeat(5001)); type("alpha"); await waitSearch();
  act(() => view.dispatch({ selection: { anchor: 29994, head: 29999 } }));
  click(t.findNext); await waitSearch();
  expect(view.state.selection.main.from).toBe(30000);
  expect(host.textContent).toContain(t.f.findCount(5001, 5001));
  expect(searchStateOf(view.state).matches).toHaveLength(1);
  click(t.findNext); await waitSearch();
  expect(view.state.selection.main.from).toBe(0);
  expect(host.textContent).toContain(t.f.findCount(1, 5001));
});
