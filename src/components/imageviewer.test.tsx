// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ImageViewer } from "./ImageViewer";
import { makeT } from "../i18n";

const t = makeT("en");

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
    const rotate = () => act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${t.imgRotate}"]`)!.click());
    try {
      expect(style()).toContain("rotate(0deg)");
      rotate();
      expect(style()).toContain("rotate(90deg)");
      act(() => host.querySelector(".imgviewer")!.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true })));
      expect(style()).toContain("rotate(0deg)");
      rotate();
      expect(style()).toContain("rotate(90deg)");
      act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${t.zoomActual}"]`)!.click());
      expect(style()).toContain("rotate(0deg)");
      rotate();
      act(() => host.querySelector(".imgviewer-stage")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
      expect(style()).toContain("rotate(0deg)");
    } finally { act(() => root.unmount()); host.remove(); }
  });
});

describe("image viewer navigation", () => {
  it("같은 주소의 다른 위치로 이동해도 확대·회전을 초기화하고 설명을 바꾼다", () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host), t = makeT("en"), onNav = vi.fn();
    const render = (occurrence: number, alt: string) => act(() => root.render(
      <ImageViewer src="https://example.com/shared.png" alt={alt} occurrence={occurrence}
        index={occurrence === 0 ? 0 : 1} total={2} onNav={onNav} t={t} onClose={() => {}} />,
    ));
    const click = (label: string) => act(() => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
    try {
      render(0, "first");
      click(t.zoomIn); click(t.imgRotate);
      expect(host.querySelector("img")!.style.transform).toContain("scale(1.25) rotate(90deg)");
      click(t.imageNext);
      expect(onNav).toHaveBeenLastCalledWith(1);
      render(40, "second");
      expect(host.querySelector("img")!.alt).toBe("second");
      expect(host.querySelector("img")!.style.transform).toBe("translate(0px, 0px) scale(1) rotate(0deg)");
      expect(host.querySelector(".imgviewer-index")!.textContent).toBe("2 / 2");
      click(t.imagePrevious);
      expect(onNav).toHaveBeenLastCalledWith(-1);
    } finally { act(() => root.unmount()); host.remove(); }
  });
});
