// 오류 경계 — 렌더 크래시가 백화가 아니라 복구 안내로.
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "./ErrorBoundary";

const Boom = (): JSX.Element => {
  throw new Error("렌더 폭발");
};

describe("ErrorBoundary", () => {
  it("자식 렌더 크래시를 잡아 복구 안내 화면", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
    });
    expect(host.textContent).toContain("다시 열기");
    expect(host.textContent).toContain("렌더 폭발"); // 에러 메시지 노출(보고 가능)
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    act(() => root.unmount());
    host.remove();
    errSpy.mockRestore();
  });
});
