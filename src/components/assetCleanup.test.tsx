// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssetCleanup } from "./AssetCleanup";
import { api, type OrphanAsset } from "../api";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, isInApp: () => true,
    api: { ...actual.api, findOrphanImages: vi.fn(), deleteOrphanImages: vi.fn() } };
});

const t = makeT("en");
const items: OrphanAsset[] = [
  { path: "/work/assets/a.png", size: 10, stamp: "a" },
  { path: "/work/assets/b.png", size: 9, stamp: "b" },
];
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => {
  vi.mocked(api.findOrphanImages).mockReset().mockResolvedValue(items);
  vi.mocked(api.deleteOrphanImages).mockReset().mockResolvedValue({ moved: [items[0].path], failed: [] });
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host?.remove();
});

async function mountPanel() {
  const io: StoreIO = {
    readDocument: async () => ({ text: "unsaved reference.png", meta: { hadBom: false, crlf: false }, mtime: 1, size: 7 }),
    writeDocument: async () => ({ mtime: 2, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
  };
  const store = new AppStore(io);
  store.state.workspace = "/work";
  await store.openPath("/work/doc.md");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = () => root!.render(<AssetCleanup store={store} t={t} onBusyChange={vi.fn()} />);
  await act(async () => { render(); });
  return { store, render };
}
function applyButton(): HTMLButtonElement { return host.querySelector<HTMLButtonElement>(".btn-danger")!; }

describe("이미지 정리 검토", () => {
  it("열린 버퍼를 전달하고 선택한 파일만 확인 후 이동한다", async () => {
    await mountPanel();
    expect(api.findOrphanImages).toHaveBeenCalledWith("/work", ["unsaved reference.png"]);
    expect(applyButton().disabled).toBe(true);
    await act(async () => { host.querySelector<HTMLInputElement>(".review-orphans input")!.click(); });
    await act(async () => { applyButton().click(); });
    expect(api.deleteOrphanImages).not.toHaveBeenCalled();
    await act(async () => { applyButton().click(); });
    expect(api.deleteOrphanImages).toHaveBeenCalledWith("/work", [items[0]], ["unsaved reference.png"]);
    expect(host.querySelectorAll(".review-orphans li")).toHaveLength(1);
    expect(host.querySelector(".review-orphans")!.textContent).toContain("b.png");
  });

  it("이동 실패 항목을 숨기지 않고 목록과 결과에 남긴다", async () => {
    vi.mocked(api.deleteOrphanImages).mockResolvedValue({
      moved: [items[0].path], failed: [{ path: items[1].path, message: "Trash unavailable" }],
    });
    await mountPanel();
    await act(async () => { host.querySelector<HTMLInputElement>(".review-select-all input")!.click(); });
    await act(async () => { applyButton().click(); });
    await act(async () => { applyButton().click(); });
    expect(host.textContent).toContain("Trash unavailable");
    expect(host.querySelector(".review-orphans")!.textContent).toContain("b.png");
    expect(applyButton().disabled).toBe(true);
  });

  it("검토 후 본문이 바뀌면 다시 검사하기 전 이동할 수 없다", async () => {
    const { store, render } = await mountPanel();
    await act(async () => { host.querySelector<HTMLInputElement>(".review-select-all input")!.click(); });
    await act(async () => {
      store.active!.state = store.active!.state.update({ changes: { from: 0, insert: "a.png" } }).state;
      render();
    });
    expect(applyButton().disabled).toBe(true);
    expect(host.textContent).toContain(t.reviewScanStale);
    expect(api.deleteOrphanImages).not.toHaveBeenCalled();
  });

  it("스캔 실패를 후보 없음으로 표시하지 않는다", async () => {
    vi.mocked(api.findOrphanImages).mockRejectedValue(new Error("Unreadable document"));
    await mountPanel();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Unreadable document");
    expect(host.textContent).not.toContain(t.reviewOrphanNone);
    expect(host.querySelector(".btn-danger")).toBeNull();
  });
});
