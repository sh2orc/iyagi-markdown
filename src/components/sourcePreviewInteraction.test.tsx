// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";
import { SourcePreview } from "./SourcePreview";
const renderPreview = vi.hoisted(() => vi.fn());
vi.mock("../export/preview", async (original) => ({ ...await original<typeof import("../export/preview")>(),
  createPreviewRenderer: () => renderPreview }));
let store: AppStore, host: HTMLDivElement, root: Root;
const t = makeT("en");
beforeEach(() => {
  vi.useFakeTimers(); renderPreview.mockReset().mockResolvedValue("<p>Preview</p>");
  const io: StoreIO = { readDocument: async () => ({ text: "", mtime: 1, size: 0, meta: { hadBom: false, crlf: false } }),
    writeDocument: async () => ({ mtime: 1, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {} };
  store = new AppStore(io); store.newTabWithContent("# Source"); store.setTheme("light");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); });
async function render() { await act(async () => root.render(<SourcePreview store={store} tab={store.active!} t={t} />)); }
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(350); }); }

it("테마가 바뀌면 이전 미리보기를 감추고 새 테마의 본문으로 갱신한다", async () => {
  await render(); await settle(); expect(host.querySelector("iframe")).not.toBeNull();
  act(() => store.setTheme("dark")); expect(host.querySelector("iframe")).toBeNull();
  await settle(); expect(renderPreview.mock.calls.at(-1)![1].theme).toBe("dark");
  expect(host.querySelector("iframe")).not.toBeNull();
});

it("본문 렌더 실패는 오류와 재시도를 제공하며 편집 문서를 유지한다", async () => {
  renderPreview.mockRejectedValueOnce(new Error("renderer failed"));
  const doc = store.active!.state.doc;
  await render(); await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("renderer failed");
  act(() => host.querySelector<HTMLButtonElement>("button")!.click()); await settle();
  expect(host.querySelector('[role="alert"]')).toBeNull(); expect(host.querySelector("iframe")).not.toBeNull();
  expect(store.active!.state.doc).toBe(doc);
});
