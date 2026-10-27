// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { EditorState, StateEffect } from "@codemirror/state";
import { undo } from "@codemirror/commands";
import { AppStore, type StoreIO } from "../app/store";
import { frontMatterLen, frontMatterMeta, stripFrontMatter } from "../editor/frontmatter";
import { makeT } from "../i18n";
import { FrontMatterDialog } from "./FrontMatterDialog";

let host: HTMLDivElement, editorHost: HTMLDivElement, root: Root, view: EditorView;
const t = makeT("en");
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div"); editorHost = document.createElement("div");
  document.body.append(host, editorHost); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); view?.destroy(); host.remove(); editorHost.remove();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});
async function mount(text: string) {
  const io: StoreIO = {
    readDocument: async () => ({ text, meta: { hadBom: false, crlf: false }, mtime: 1, size: text.length }),
    writeDocument: async () => ({ mtime: 2, size: text.length }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
  };
  const store = new AppStore(io); store.newTabWithContent(text);
  view = new EditorView({ state: store.active!.state, parent: editorHost }); store.view = view;
  const close = vi.fn(), toast = vi.spyOn(store, "toast");
  await act(async () => root.render(<FrontMatterDialog store={store} t={t} onClose={close} />));
  return { store, close, toast };
}
function title() { return host.querySelector<HTMLInputElement>(".settings-label input")!; }
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title(), value);
    title().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(label: string) { return [...host.querySelectorAll("button")].find((node) => node.textContent === label)!; }

it("아무 항목도 바꾸지 않으면 목록·주석·옵션을 다시 쓰지 않는다", async () => {
  const source = "---\ntitle: Old\nauthors:\n  - A\n  - B\ncover: assets/cover.png\ntoc: yes # keep\n---\nBody";
  const { close, toast } = await mount(source);
  await act(async () => button(t.save).click());
  expect(view.state.doc.toString()).toBe(source);
  expect(close).toHaveBeenCalledTimes(1);
  expect(toast).not.toHaveBeenCalledWith(t.fmSaved);
});

it("제목만 바꾸며 최신 본문과 커서 위치를 보존하고 정보 변경만 실행 취소한다", async () => {
  const source = "---\ntitle: Old\nauthors:\n  - A\n---\nBody";
  await mount(source); await type("New: #1");
  view.dispatch({ changes: { from: view.state.doc.length, insert: " appended" } });
  const before = view.state.doc.toString();
  view.dispatch({ selection: { anchor: before.indexOf("Body") + 2 } });
  await act(async () => button(t.save).click());
  const next = view.state.doc.toString();
  expect(frontMatterMeta(next)?.title).toBe("New: #1");
  expect(next).toContain("authors:\n  - A\n");
  expect(stripFrontMatter(next)).toBe("Body appended");
  expect(view.state.selection.main.head).toBe(frontMatterLen(next) + 2);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(before);
});

it("활성 문서가 바뀌어도 입력을 초기화하거나 새 문서에 적용하지 않는다", async () => {
  const { store, close } = await mount("---\ntitle: Old\n---\nBody");
  await type("My draft");
  await act(async () => store.newTabWithContent("# Another document"));
  expect(title().value).toBe("My draft");
  expect(host.textContent).toContain(t.fmTargetChanged);
  await act(async () => { title().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  expect(view.state.doc.toString()).toBe("# Another document");
  expect(close).not.toHaveBeenCalled();
});

it("같은 문서의 정보가 외부에서 바뀌면 덮어쓰지 않고 초안을 유지한다", async () => {
  const { close } = await mount("---\ntitle: Old\n---\nBody");
  await type("My draft");
  view.dispatch({ changes: { from: 11, to: 14, insert: "External" } });
  const before = view.state.doc.toString();
  await act(async () => button(t.save).click());
  expect(view.state.doc.toString()).toBe(before);
  expect(title().value).toBe("My draft");
  expect(host.textContent).toContain(t.fmChanged);
  expect(close).not.toHaveBeenCalled();
});

it("적용이 필터로 거절되어도 성공 안내를 하지 않고 입력을 남긴다", async () => {
  const source = "---\ntitle: Old\n---\nBody";
  const { close, toast } = await mount(source); await type("My draft");
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
  await act(async () => button(t.save).click());
  expect(view.state.doc.toString()).toBe(source);
  expect(host.textContent).toContain(t.fmApplyFailed);
  expect(title().value).toBe("My draft");
  expect(close).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalledWith(t.fmSaved);
});

it("창을 연 뒤 읽기 전용이 되면 닫거나 입력을 버리지 않는다", async () => {
  const source = "---\ntitle: Old\n---\nBody";
  const { store, close } = await mount(source); await type("My draft");
  await act(async () => {
    view.setState(EditorState.create({ doc: source, extensions: [EditorState.readOnly.of(true)] }));
    store.setSidebar(false);
  });
  expect(host.textContent).toContain(t.fmReadOnly);
  expect(button(t.save).disabled).toBe(true);
  expect(title().value).toBe("My draft");
  expect(close).not.toHaveBeenCalled();
});

it("Escape·취소·배경 클릭은 초안을 확인하고 버릴 때만 닫는다", async () => {
  const { close } = await mount("Body"); await type("Keep me");
  await act(async () => { title().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(host.textContent).toContain(t.fmDiscardPrompt);
  expect(close).not.toHaveBeenCalled();
  await act(async () => button(t.commentKeepEditing).click());
  expect(title().value).toBe("Keep me");
  await act(async () => host.querySelector<HTMLElement>(".overlay")!.click());
  await act(async () => button(t.commentDiscard).click());
  expect(close).toHaveBeenCalledTimes(1);
});
