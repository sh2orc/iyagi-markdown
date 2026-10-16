// 이미지 뷰어 — 리셋 의미론(회전 포함) 실렌더 검증.
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ImageViewer } from "./ImageViewer";
import type { Translate } from "../i18n";

const t = {} as Translate; // 라벨 렌더에만 쓰임 — 동작 무관

function mountViewer(): { host: HTMLDivElement; root: ReturnType<typeof createRoot>; img: () => HTMLImageElement } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => {
    root.render(<ImageViewer src="/tmp/x.png" alt="사진" t={t} onClose={vi.fn()} />);
  });
  return { host, root, img: () => host.querySelector("img")! };
}

describe("이미지 뷰어 리셋 — 회전 포함", () => {
  it("회전 후 0 키·1:1·더블클릭 모두 원본(회전 0)으로", () => {
    const { host, root, img } = mountViewer();
    const style = (): string => img().getAttribute("style") ?? "";
    expect(style()).toContain("rotate(0deg)");

    // 회전 90°
    act(() => {
      (host.querySelectorAll("button") as NodeListOf<HTMLButtonElement>).forEach((b) => {
        if (b.textContent === "\u21bb") b.click();
      });
    });
    expect(style()).toContain("rotate(90deg)");

    // 0 키로 리셋
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "0" }));
    });
    expect(style()).toContain("rotate(0deg)");

    // 다시 회전 후 1:1 버튼
    act(() => {
      (host.querySelectorAll("button") as NodeListOf<HTMLButtonElement>).forEach((b) => {
        if (b.textContent === "\u21bb") b.click();
      });
    });
    expect(style()).toContain("rotate(90deg)");
    act(() => {
      (host.querySelectorAll("button") as NodeListOf<HTMLButtonElement>).forEach((b) => {
        if (b.textContent === "1:1") b.click();
      });
    });
    expect(style()).toContain("rotate(0deg)");

    act(() => root.unmount());
    host.remove();
  });
});
