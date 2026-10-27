// 링크 대화상자 IME 가드 — 한글 조합 중 Enter/Esc가 앱 동작으로 새는 것 방지.
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { LinkDialog } from "./LinkDialog";
import { makeT } from "../i18n";

const t = makeT("en");

function mountDialog(confirm: (next: { text: string; url: string }) => void | Promise<void>, cancel: () => void): { host: HTMLDivElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <LinkDialog
        initial={{ text: "안녕", url: "https://example.com", from: 0, to: 0 }}
        t={t}
        onConfirm={confirm}
        onCancel={cancel}
      />,
    );
  });
  return { host, root };
}

describe("링크 대화상자 IME 가드", () => {
  it("조합 중 Enter·Esc는 IME가 소비 — 확인·취소로 새지 않는다", () => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    const { host, root } = mountDialog(confirm, cancel);
    // initial.text가 있으면 URL 필드가 포커스 — 두 번째 input.
    const urlInput = host.querySelectorAll("input")[1]!;
    const comp = { isComposing: true } as const;

    urlInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...comp }),
    );
    expect(confirm).not.toHaveBeenCalled(); // 조합 확정이지 저장이 아니다

    urlInput.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...comp }),
    );
    expect(cancel).not.toHaveBeenCalled(); // 조합 취소이지 닫기가 아니다

    urlInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(cancel).toHaveBeenCalledTimes(1); // 조합 아님 — 정상 닫기

    act(() => root.unmount());
    host.remove();
  });
});

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function button(host: HTMLElement, text: string) {
  return [...host.querySelectorAll("button")].find((node) => node.textContent === text)!;
}

it("적용 실패 후 입력을 유지하고 같은 내용으로 재시도할 수 있다", async () => {
  const confirm = vi.fn().mockRejectedValueOnce(new Error("target changed")).mockResolvedValue(undefined);
  const cancel = vi.fn();
  const { host, root } = mountDialog(confirm, cancel);
  try {
    act(() => type(host.querySelector("input")!, "new [label]"));
    await act(async () => button(host, t.save).click());
    expect(host.textContent).toContain("target changed");
    expect(host.querySelector("input")!.value).toBe("new [label]");
    expect(cancel).not.toHaveBeenCalled();
    await act(async () => button(host, t.save).click());
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith({ text: "new [label]", url: "https://example.com" });
  } finally { act(() => root.unmount()); host.remove(); }
});

it("변경한 입력은 Escape로 바로 버리지 않고 확인 후 닫는다", () => {
  const cancel = vi.fn();
  const { host, root } = mountDialog(vi.fn(), cancel);
  try {
    act(() => type(host.querySelector("input")!, "keep"));
    act(() => { host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(host.textContent).toContain(t.linkDiscardPrompt);
    expect(cancel).not.toHaveBeenCalled();
    act(() => button(host, t.commentKeepEditing).click());
    expect(host.querySelector("input")!.value).toBe("keep");
    act(() => button(host, t.cancel).click());
    act(() => button(host, t.commentDiscard).click());
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally { act(() => root.unmount()); host.remove(); }
});

it("처리 중 Enter 중복 제출·Escape·배경 닫기를 막고 빈 설명을 그대로 전달한다", async () => {
  let finish!: () => void;
  const confirm = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const cancel = vi.fn();
  const { host, root } = mountDialog(confirm, cancel);
  try {
    act(() => type(host.querySelector("input")!, ""));
    act(() => {
      const input = host.querySelector("input")!;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      host.querySelector<HTMLElement>(".overlay")!.click();
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith({ text: "", url: "https://example.com" });
    expect(cancel).not.toHaveBeenCalled();
    expect(host.querySelector("input")!.readOnly).toBe(true);
    await act(async () => finish());
  } finally { act(() => root.unmount()); host.remove(); }
});
