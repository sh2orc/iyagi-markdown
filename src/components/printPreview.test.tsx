// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { AppStore, type StoreIO } from "../app/store";
import { makeT } from "../i18n";
import { PrintPreview } from "./PrintPreview";
import type { ExportResult } from "../export/result";
const mocks = vi.hoisted(() => ({ render: vi.fn(), frame: vi.fn() }));
vi.mock("../export/preview", async (original) => ({ ...await original<typeof import("../export/preview")>(),
  createPreviewRenderer: () => mocks.render }));
vi.mock("../export/printFrame", () => ({ connectPrintFrame: mocks.frame }));
let host: HTMLDivElement, root: Root, store: AppStore, props: ComponentProps<typeof PrintPreview>;
const t = makeT("en");
beforeEach(() => {
  vi.useFakeTimers();
  mocks.render.mockReset().mockResolvedValue("<!doctype html><html><body>Preview</body></html>");
  mocks.frame.mockReset().mockReturnValue(() => {});
  const io: StoreIO = { readDocument: async () => ({ text: "", mtime: 1, size: 0, meta: { hadBom: false, crlf: false } }),
    writeDocument: async () => ({ mtime: 1, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {} };
  store = new AppStore(io); store.newTabWithContent("# Original");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = { store, t, onCancel: vi.fn(), onExport: vi.fn().mockResolvedValue({ status: "saved", path: "/exports/Report.pdf" }),
    saved: { paper: "a5", landscape: true, margin: 14, scale: 1 } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;
async function render() { await act(async () => root.render(<PrintPreview {...props} />)); }
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(300); }); }
async function ready() {
  await act(async () => host.querySelector("iframe")!.dispatchEvent(new Event("load")));
  await act(async () => { mocks.frame.mock.calls.at(-1)![2](); });
}

it("렌더·프레임 준비 전 인쇄를 막고 저장된 가로 방향과 검토한 스냅샷을 PDF에 넘긴다", async () => {
  await render(); expect(button(t.printButton).disabled).toBe(true); expect(button("PDF").disabled).toBe(true);
  expect(host.querySelector<HTMLSelectElement>(`[aria-label="${t.exportOrientation}"]`)!.value).toBe("landscape");
  await settle(); expect(button("PDF").disabled).toBe(true);
  expect(host.querySelector<HTMLIFrameElement>("iframe")!.style.width).toBe("210mm");
  await ready(); expect(button("PDF").disabled).toBe(false);
  await act(async () => button("PDF").click());
  expect(props.onExport).toHaveBeenCalledWith("pdf", { paper: "a5", orientation: "landscape", marginMm: 14, scale: 1 },
    mocks.render.mock.calls[0][0], host.querySelector("iframe")!.getAttribute("srcdoc"));
  expect(host.querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-same-origin allow-modals");
});

it("옵션 연속 조절을 합치고 이전 프레임이 준비됐어도 변경 직후 인쇄를 막는다", async () => {
  await render(); await settle(); await ready();
  const select = host.querySelector<HTMLSelectElement>(`[aria-label="${t.exportOrientation}"]`)!;
  act(() => { select.value = "portrait"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(button("PDF").disabled).toBe(true);
  act(() => { select.value = "landscape"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(mocks.render).toHaveBeenCalledTimes(1);
  await settle(); expect(mocks.render).toHaveBeenCalledTimes(2);
  await ready(); expect(button("PDF").disabled).toBe(false);
});

it("실패를 표시하고 옵션을 유지한 재시도가 가능하다", async () => {
  mocks.render.mockRejectedValueOnce(new Error("diagram failed"));
  await render(); await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("diagram failed");
  expect(button("PDF").disabled).toBe(true);
  await act(async () => button(t.wsRetry).click()); await settle(); await ready();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(mocks.render.mock.calls[1][1]).toMatchObject({ paper: "a5", orientation: "landscape" });
});

it.each([false, true])("이전 문서의 느린 응답(실패 %s)이 새 문서 미리보기를 덮지 않는다", async (fail) => {
  let finish!: (html: string) => void;
  let reject!: (reason: Error) => void;
  mocks.render.mockImplementationOnce(() => new Promise((resolve, no) => { finish = resolve; reject = no; }));
  await render(); await settle();
  act(() => store.newTabWithContent("# New document"));
  await settle(); await ready();
  const frame = host.querySelector("iframe");
  await act(async () => { if (fail) reject(new Error("stale failure")); else finish("<p>Stale preview</p>"); });
  expect(host.querySelector("iframe")).toBe(frame);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button("PDF").click());
  expect(vi.mocked(props.onExport).mock.calls[0][2].text).toBe("# New document");
});

it("조합 중 Escape는 유지하고 일반 Escape로 닫는다", async () => {
  await render(); const dialog = host.querySelector('[role="dialog"]')!;
  act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
  expect(props.onCancel).not.toHaveBeenCalled();
  act(() => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(props.onCancel).toHaveBeenCalledTimes(1);
});

it("PDF 취소·실패 뒤 미리보기와 옵션을 유지하고 같은 HTML로 재시도한다", async () => {
  vi.mocked(props.onExport).mockResolvedValueOnce({ status: "cancelled" })
    .mockResolvedValueOnce({ status: "failed", message: "disk full" });
  await render(); await settle(); await ready();
  const frame = host.querySelector("iframe");
  await act(async () => button("PDF").click());
  expect(host.textContent).toContain(t.exportCancelled); expect(props.onCancel).not.toHaveBeenCalled();
  await act(async () => button("PDF").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("disk full");
  await act(async () => button("PDF").click());
  expect(host.textContent).toContain("/exports/Report.pdf"); expect(button("PDF").disabled).toBe(true);
  const calls = vi.mocked(props.onExport).mock.calls;
  expect(calls[1]).toEqual(calls[0]); expect(calls[2]).toEqual(calls[0]);
  expect(host.querySelector("iframe")).toBe(frame); expect(mocks.render).toHaveBeenCalledTimes(1);
  await act(async () => button(t.done).click()); expect(props.onCancel).toHaveBeenCalledTimes(1);
});

it("PDF 저장 중 중복 클릭·Escape·배경 닫기를 막고 실패 뒤 닫기를 허용한다", async () => {
  let finish!: (result: ExportResult) => void;
  vi.mocked(props.onExport).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render(); await settle(); await ready();
  const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
  act(() => {
    button("PDF").click(); button("PDF").click();
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    dialog.click(); button(t.cancel).click();
  });
  expect(props.onExport).toHaveBeenCalledTimes(1); expect(props.onCancel).not.toHaveBeenCalled();
  expect(button(t.cancel).disabled).toBe(true);
  await act(async () => finish({ status: "failed", message: "permission denied" }));
  await act(async () => button(t.cancel).click()); expect(props.onCancel).toHaveBeenCalledTimes(1);
});
