// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TrackPanel } from "./TrackPanel";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";

const t = makeT("en");
let root: Root | undefined;
let host: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
  vi.restoreAllMocks();
});
function button(text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
}
async function mount(initialAction?: "accept" | "stop", loadFails = false) {
  const io: StoreIO = {
    readDocument: async () => ({ text: "current", meta: { hadBom: false, crlf: false }, mtime: 1, size: 7 }),
    writeDocument: async () => ({ mtime: 2, size: 7 }),
    scanWorkspace: async () => ({ tree: [], issues: [] }), saveSession: async () => {},
    setAssetScope: async () => {}, watchPaths: async () => {},
    baselineGet: async () => {
      if (loadFails) throw new Error("read failed");
      return { text: "original", revision: 1 };
    },
  };
  const store = new AppStore(io);
  store.newTabWithContent("current");
  store.active!.path = "/tracked.md";
  store.active!.title = "tracked.md";
  const close = vi.fn();
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<TrackPanel store={store} t={t} initialAction={initialAction} onClose={close} />));
  return { store, io, close };
}

describe("변경 추적 확인과 대상 보존", () => {
  it("수락은 확인 화면에 표시한 스냅샷으로 한 번만 제출한다", async () => {
    const { store, close } = await mount("accept");
    const expectedDoc = store.active!.state.doc;
    let finish!: (ok: boolean) => void;
    const accept = vi.spyOn(store, "acceptAllChanges").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    expect(host.textContent).toContain(t.trackAcceptPrompt);
    expect(accept).not.toHaveBeenCalled();
    act(() => {
      button(t.trackAccept).click();
      button(t.trackAccept).click();
      host.querySelector<HTMLElement>(".overlay")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ path: "/tracked.md", baseline: "original", doc: expectedDoc }));
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish(false));
    expect(host.textContent).toContain(t.trackSaveFailed);
  });

  it("조회 오류를 추적 꺼짐으로 표시하지 않고 재조회한다", async () => {
    const { io } = await mount(undefined, true);
    expect(host.textContent).toContain(t.trackLoadFailed);
    expect(host.textContent).not.toContain(t.trackNotActive);
    expect(button(t.trackStart).disabled).toBe(true);
    io.baselineGet = async () => ({ text: null, revision: 2 });
    await act(async () => button(t.wsRetry).click());
    expect(host.textContent).toContain(t.trackNotActive);
    expect(button(t.trackStart).disabled).toBe(false);
  });

  it("패널이 열린 동안 다른 문서로 전환하면 되돌리기·수락을 비활성화한다", async () => {
    const { store } = await mount();
    act(() => { store.newTabWithContent("other"); });
    expect(host.textContent).toContain(t.trackTargetChanged);
    expect(button(t.trackAccept).disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>(".track-revert")!.disabled).toBe(true);
    expect(host.textContent).toContain("tracked.md");
  });

  it("잠긴 문서의 변경 되돌리기는 비활성화한다", async () => {
    const { store } = await mount();
    act(() => store.setLocked(store.active!.id, true));
    for (const revert of host.querySelectorAll<HTMLButtonElement>(".track-revert")) expect(revert.disabled).toBe(true);
  });
});
