// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "../api";
import type { AppStore } from "../app/store";
import { makeT } from "../i18n";
import { NewFolderDialog } from "./NewFolderDialog";

const t = makeT("en"), close = vi.fn(), created = vi.fn();
let host: HTMLDivElement, root: Root, store: { state: { workspace: string }; toast: ReturnType<typeof vi.fn> };
const input = () => host.querySelector<HTMLInputElement>("input")!;
function render(workspace = "/w", dir = "/w/Notes") {
  root.render(<NewFolderDialog key={`${workspace}:${dir}`} store={store as unknown as AppStore}
    root={workspace} dir={dir} t={t} onClose={close} onCreated={created} />);
}
function type(name: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), name);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function submit() { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }
function key(name: string, isComposing = false) {
  const event = new KeyboardEvent("keydown", { key: name, isComposing, bubbles: true, cancelable: true });
  act(() => input().dispatchEvent(event)); return event;
}
beforeEach(() => {
  store = { state: { workspace: "/w" }, toast: vi.fn() };
  vi.spyOn(api, "newFolderIn").mockResolvedValue("/w/Notes/New");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => render());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); close.mockReset(); created.mockReset(); });

it("생성 위치를 표시하고 같은 이름 오류 후 입력을 유지해 재시도한다", async () => {
  vi.mocked(api.newFolderIn).mockRejectedValueOnce({ code: "exists" });
  expect(host.textContent).toContain("/w/Notes");
  type(" New "); await act(async () => submit());
  expect(input().value).toBe(" New "); expect(host.textContent).toContain(t.folderExists);
  expect(created).not.toHaveBeenCalled();
  await act(async () => submit());
  expect(api.newFolderIn).toHaveBeenLastCalledWith("/w", "/w/Notes", "New");
  expect(created).toHaveBeenCalledWith("/w/Notes/New");
});

it("생성 중 중복 제출과 닫기를 막고 완료된 요청을 다시 생성하지 않는다", async () => {
  let finish!: (path: string) => void;
  vi.mocked(api.newFolderIn).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  type("New"); act(() => { submit(); submit(); }); key("Escape");
  expect(api.newFolderIn).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish("/w/Notes/New"));
  await act(async () => submit());
  expect(api.newFolderIn).toHaveBeenCalledTimes(1); expect(created).toHaveBeenCalledTimes(1);
});

it.each(["../outside", "a/b", "a\\b", ".", ".."])("잘못된 이름 %s는 디스크 작업을 요청하지 않는다", async (name) => {
  type(name); await act(async () => submit());
  expect(api.newFolderIn).not.toHaveBeenCalled(); expect(host.textContent).toContain(t.folderInvalidName);
});

it.each([['hiddenName', 'folderHiddenName'], ['depth', 'folderDepth'], ['outside', 'folderTargetChanged']] as const)(
  "%s 오류를 번역된 안내로 표시한다", async (code, message) => {
    vi.mocked(api.newFolderIn).mockRejectedValueOnce({ code });
    type("New"); await act(async () => submit()); expect(host.textContent).toContain(t[message]);
  });

it("IME Enter·Escape는 생성이나 닫기로 해석하지 않는다", () => {
  type("회의");
  act(() => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  expect(key("Enter", true).defaultPrevented).toBe(false); key("Escape", true);
  act(submit);
  expect(api.newFolderIn).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  act(() => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  key("Escape"); expect(close).toHaveBeenCalledTimes(1);
});

it("다른 워크스페이스로 전환된 뒤의 응답은 새 대화상자를 닫지 않는다", async () => {
  let finish!: (path: string) => void;
  vi.mocked(api.newFolderIn).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  type("New"); act(submit);
  store.state.workspace = "/other"; act(() => render("/other", "/other"));
  await act(async () => finish("/w/Notes/New"));
  expect(created).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  expect(store.toast).toHaveBeenCalledWith(`${t.folderCreated}: /w/Notes/New`);
  expect(host.textContent).toContain("/other"); expect(input().disabled).toBe(false);
});

it("제출 전에 바뀐 워크스페이스는 생성하지 않는다", async () => {
  store.state.workspace = "/other"; type("New"); await act(async () => submit());
  expect(api.newFolderIn).not.toHaveBeenCalled(); expect(host.textContent).toContain(t.folderTargetChanged);
});
