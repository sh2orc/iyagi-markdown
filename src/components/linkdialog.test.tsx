// 링크 대화상자 IME 가드 — 한글 조합 중 Enter/Esc가 앱 동작으로 새는 것 방지.
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { LinkDialog } from "./LinkDialog";
import type { Translate } from "../i18n";

const t = {} as Translate; // 라벨 렌더에만 쓰임 — 동작 무관

function mountDialog(confirm: () => void, cancel: () => void): { host: HTMLDivElement; root: ReturnType<typeof createRoot> } {
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
