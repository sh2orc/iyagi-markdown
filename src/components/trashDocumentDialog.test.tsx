// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type TrashDocument } from "../api";
import type { AppStore } from "../app/store";
import { makeT } from "../i18n";
import { TrashDocumentDialog } from "./TrashDocumentDialog";

const t = makeT("en"), close = vi.fn();
const reviewed: TrashDocument = { root: "/w", path: "/w/Notes/a.md", canonicalRoot: "/w", stamp: "one", size: 3 };
let host: HTMLDivElement, root: Root, valid: boolean;
let store: { state: { workspace: string }; toast: ReturnType<typeof vi.fn>; trashDocument: ReturnType<typeof vi.fn> };
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!;
function render() {
  root.render(<TrashDocumentDialog store={store as unknown as AppStore} root="/w" path={reviewed.path}
    isCurrent={() => valid} t={t} onClose={close} />);
}
function escape(composing = false) {
  host.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: composing, bubbles: true }));
}
beforeEach(async () => {
  valid = true;
  store = { state: { workspace: "/w" }, toast: vi.fn(), trashDocument: vi.fn().mockResolvedValue(undefined) };
  vi.spyOn(api, "reviewDocumentTrash").mockResolvedValue(reviewed);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => render());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); close.mockReset(); });

it("전체 경로와 복구 안내를 표시하고 기본 포커스는 취소에 둔다", () => {
  expect(host.textContent).toContain(reviewed.path);
  expect(host.textContent).toContain(t.trashHint); expect(host.textContent).toContain(t.trashBufferHint);
  expect(document.activeElement).toBe(button(t.cancel));
  expect(api.reviewDocumentTrash).toHaveBeenCalledWith("/w", reviewed.path);
  expect(store.trashDocument).not.toHaveBeenCalled();
  act(() => escape(true)); expect(close).not.toHaveBeenCalled();
  act(() => escape()); expect(close).toHaveBeenCalledTimes(1);
});

it("진행 중 중복 클릭과 닫기를 막고 완료된 대상을 다시 옮기지 않는다", async () => {
  let finish!: () => void;
  store.trashDocument.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const move = button(t.trashAction);
  act(() => { move.click(); move.click(); escape(); button(t.cancel).click(); });
  expect(store.trashDocument).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
  expect(host.querySelector('[role="dialog"]')?.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish());
  expect(close).toHaveBeenCalledTimes(1); expect(store.toast).toHaveBeenCalledWith(`${t.trashDone}: ${reviewed.path}`);
  await act(async () => button(t.trashAction).click());
  expect(store.trashDocument).toHaveBeenCalledTimes(1);
});

it("실패 뒤 새 파일 상태를 검토하고 별도 확인을 받아 재시도한다", async () => {
  store.trashDocument.mockRejectedValueOnce({ code: "changed" });
  await act(async () => button(t.trashAction).click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.trashChanged);
  expect(button(t.trashAction)).toBeUndefined();
  const replacement = { ...reviewed, stamp: "two" };
  vi.mocked(api.reviewDocumentTrash).mockResolvedValueOnce(replacement);
  await act(async () => button(t.trashReview).click());
  expect(store.trashDocument).toHaveBeenCalledTimes(1);
  await act(async () => button(t.trashAction).click());
  expect(store.trashDocument).toHaveBeenLastCalledWith(replacement, expect.any(Function));
});

it.each([["outside", "trashOutside"], ["otherWindows", "trashOtherWindows"], ["recoveryUnavailable", "trashRecoveryUnavailable"]] as const)(
  "%s 오류를 번역된 안내로 보여 준다", async (code, key) => {
    store.trashDocument.mockRejectedValueOnce({ code });
    await act(async () => button(t.trashAction).click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t[key]);
    expect(close).not.toHaveBeenCalled();
  });

it("같은 경로의 워크스페이스를 다시 열어도 오래된 확인은 사용할 수 없다", async () => {
  valid = false;
  await act(async () => button(t.trashAction).click());
  expect(store.trashDocument).not.toHaveBeenCalled(); expect(host.textContent).toContain(t.trashChanged);
  expect(button(t.trashReview).disabled).toBe(true);
});

it("다른 창이나 화면으로 이동해 해제되면 대기 중 요청의 유효성을 취소한다", async () => {
  let finish!: () => void;
  store.trashDocument.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  act(() => button(t.trashAction).click());
  const current = store.trashDocument.mock.calls[0][1] as () => boolean;
  expect(current()).toBe(true);
  act(() => root.render(null)); expect(current()).toBe(false);
  // The native operation may already have completed; still report its result.
  await act(async () => finish());
  expect(close).not.toHaveBeenCalled(); expect(store.toast).toHaveBeenCalledWith(`${t.trashDone}: ${reviewed.path}`);
});
