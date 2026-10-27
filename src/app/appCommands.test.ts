// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { guardAppCommands, handleAppShortcut } from "./appCommands";

const key = (value: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", {
  key: value, metaKey: true, bubbles: true, cancelable: true, ...init,
});

describe("app command routing", () => {
  it("열린 대화상자·진행 작업은 같은 라우터에서 메뉴와 단축키를 막는다", () => {
    let blocked = true;
    const run = vi.fn(), notice = vi.fn();
    const dispatch = guardAppCommands(() => blocked, run, notice);
    dispatch("recent:/w/other.md");
    dispatch("next-tab");
    const save = key("s"), mode = key("e");
    handleAppShortcut(save, dispatch);
    handleAppShortcut(mode, dispatch);
    expect(run).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(4);
    expect(save.defaultPrevented).toBe(true);
    expect(mode.defaultPrevented).toBe(true);
    // The same subscribed handler sees the new state without a resubscription.
    blocked = false;
    handleAppShortcut(key("s"), dispatch);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("save");
  });

  it("입력창이 처리한 키·IME·일반 편집 단축키를 건드리지 않는다", () => {
    const dispatch = vi.fn();
    const handled = key("s"); handled.preventDefault();
    const untouched = [key("s", { isComposing: true }), key("s", { keyCode: 229 }),
      key("t"), key("t", { shiftKey: true, isComposing: true }), key("t", { shiftKey: true, altKey: true }),
      key("a"), key("c"), key("x"), key("v"), key("z"), key("s", { altKey: true }),
      key("e", { shiftKey: true }), key("s", { metaKey: false })];
    handleAppShortcut(handled, dispatch);
    for (const event of untouched) {
      handleAppShortcut(event, dispatch);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("닫은 탭 단축키도 모달 가드와 반복 입력 억제를 따른다", () => {
    const run = vi.fn(), blocked = vi.fn();
    const dispatch = guardAppCommands(() => true, run, blocked);
    handleAppShortcut(key("t", { shiftKey: true }), dispatch);
    const repeated = key("t", { shiftKey: true, repeat: true });
    handleAppShortcut(repeated, dispatch);
    expect(run).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledTimes(1);
    expect(repeated.defaultPrevented).toBe(true);
  });

  it("⌥⌘T는 목차 — ⇧⌘T(닫은 탭)와 갈린다(메뉴 가속기 중복 수정)", () => {
    const run = vi.fn();
    const dispatch = guardAppCommands(() => false, run, vi.fn());
    handleAppShortcut(key("t", { altKey: true }), dispatch);
    expect(run).toHaveBeenCalledWith("toggle-toc");
    expect(run).toHaveBeenCalledTimes(1);
    // ⇧⌥⌘T 조합은 목차로 해석하지 않는다(alt+shift는 비활성 슬롯).
    handleAppShortcut(key("t", { altKey: true, shiftKey: true }), dispatch);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("⌘N은 새 탭 — 시작 화면·단축키 패널이 안내하던 바로 그 배치", () => {
    const run = vi.fn();
    const dispatch = guardAppCommands(() => false, run, vi.fn());
    handleAppShortcut(key("n"), dispatch);
    expect(run).toHaveBeenCalledWith("new-tab");
    handleAppShortcut(key("n", { shiftKey: true }), dispatch);
    expect(run).toHaveBeenCalledTimes(1); // ⇧⌘N은 미할당
  });

  it("로컬 입력 처리 뒤 버블링할 때 이미 처리한 저장을 반복하지 않는다", () => {
    const input = document.createElement("input");
    document.body.append(input);
    const local = vi.fn(), app = vi.fn();
    const listener = (event: KeyboardEvent) => handleAppShortcut(event, app);
    input.addEventListener("keydown", (event) => { event.preventDefault(); local(); });
    window.addEventListener("keydown", listener);
    try {
      input.dispatchEvent(key("s"));
      expect(local).toHaveBeenCalledTimes(1);
      expect(app).not.toHaveBeenCalled();
    } finally { window.removeEventListener("keydown", listener); input.remove(); }
  });

  it("길게 누른 저장·열기는 브라우저 기본 동작만 막고 명령은 반복하지 않는다", () => {
    const dispatch = vi.fn();
    for (const value of ["s", "o", "p"]) {
      const repeated = key(value, { repeat: true });
      handleAppShortcut(repeated, dispatch);
      expect(repeated.defaultPrevented).toBe(true);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["s", {}, "save"], ["s", { shiftKey: true }, "save-as"],
    ["f", { shiftKey: true }, "workspace-search"], ["f", { altKey: true }, "replace"],
    ["g", { shiftKey: true }, "find-prev"], ["p", {}, "print"],
    ["p", { shiftKey: true }, "command-palette"], ["o", { shiftKey: true }, "open-folder"],
    [",", {}, "settings"],
    ["t", { shiftKey: true }, "reopen-closed-tab"],
    ["ArrowLeft", { altKey: true }, "navigate-back"],
    ["ArrowRight", { altKey: true }, "navigate-forward"],
  ] as Array<[string, KeyboardEventInit, string]>)("%s %j → %s", (value, modifiers, command) => {
    const dispatch = vi.fn();
    handleAppShortcut(key(value, { metaKey: false, ctrlKey: true, ...modifiers }), dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(command);
  });
});
