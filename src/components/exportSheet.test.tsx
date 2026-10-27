// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { makeT } from "../i18n";
import { captureExportSnapshot } from "../export/snapshot";
import type { ExportResult } from "../export/result";
import { ExportSheet } from "./ExportSheet";
let host: HTMLDivElement, root: Root, props: ComponentProps<typeof ExportSheet>;
const t = makeT("en");
const snapshot = (text = "# Original") => captureExportSnapshot({ state: EditorState.create({ doc: text }),
  path: "/docs/original.md", title: "original.md", docStyle: null, comments: [], savedText: text },
{ workspace: "/docs", theme: "light", wikiIndex: new Map(), pageNumbers: true, header: true, lang: "en" });
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = { kind: "pdf", t, capture: vi.fn(() => snapshot()), onRun: vi.fn().mockResolvedValue({ status: "saved", path: "/output/Custom.pdf" }),
    onCancel: vi.fn(), onReveal: vi.fn().mockResolvedValue(undefined), pageNumbers: true, pdfHeader: true,
    saved: { paper: "a5", landscape: true, margin: 18, scale: 1.5 } };
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
async function render() { await act(async () => root.render(<ExportSheet {...props} />)); }
const runButton = () => host.querySelector<HTMLButtonElement>(".btn-primary")!;
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;
function escape(composing = false) {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, isComposing: composing });
  host.querySelector('[role="dialog"]')!.dispatchEvent(event); return event;
}

it("저장 취소와 실패 뒤에도 옵션·원래 문서를 유지하며 새 저장 위치로 재시도한다", async () => {
  vi.mocked(props.onRun).mockResolvedValueOnce({ status: "cancelled" }).mockRejectedValueOnce(new Error("disk full"));
  await render(); await act(async () => runButton().click());
  expect(host.textContent).toContain(t.exportCancelled); expect(props.onCancel).not.toHaveBeenCalled();
  props.capture = vi.fn(() => snapshot("# Different active document"));
  props.saved = { paper: "letter", landscape: false, margin: 0, scale: 2 };
  await render(); await act(async () => runButton().click());
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("disk full");
  await act(async () => runButton().click());
  for (const [kind, options, doc] of vi.mocked(props.onRun).mock.calls) {
    expect(kind).toBe("pdf"); expect(options).toEqual({ paper: "a5", orientation: "landscape", marginMm: 18, scale: 1.5 });
    expect(doc.text).toBe("# Original");
  }
  expect(props.capture).not.toHaveBeenCalled();
  expect(host.textContent).toContain("/output/Custom.pdf"); expect(runButton().disabled).toBe(true);
  await act(async () => button(t.done).click()); expect(props.onCancel).toHaveBeenCalledTimes(1);
});

it("같은 이벤트 안의 중복 실행과 진행 중 Escape·배경·취소를 막는다", async () => {
  let finish!: (result: ExportResult) => void;
  vi.mocked(props.onRun).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render();
  act(() => { runButton().click(); runButton().click(); escape();
    host.querySelector<HTMLElement>('[role="dialog"]')!.click(); button(t.cancel).click(); });
  expect(props.onRun).toHaveBeenCalledTimes(1); expect(props.onCancel).not.toHaveBeenCalled();
  expect(host.querySelector("fieldset")!.disabled).toBe(true);
  expect(host.querySelector('[role="status"]')?.textContent).toContain(t.exportPreparing);
  await act(async () => finish({ status: "failed", message: "write failed" }));
  expect(runButton().disabled).toBe(false);
  act(() => escape(true)); expect(props.onCancel).not.toHaveBeenCalled();
  act(() => escape()); expect(props.onCancel).toHaveBeenCalledTimes(1);
});

it("저장 완료 뒤 Finder 표시 실패를 저장 실패로 바꾸거나 내보내기를 반복하지 않는다", async () => {
  vi.mocked(props.onReveal!).mockRejectedValueOnce(new Error("Finder unavailable"));
  await render(); await act(async () => runButton().click());
  await act(async () => button(t.tabReveal).click());
  expect(host.textContent).toContain(t.exportSavedTo); expect(host.textContent).toContain(t.exportRevealFailed);
  expect(host.textContent).toContain("/output/Custom.pdf"); expect(runButton().disabled).toBe(true);
  await act(async () => button(t.tabReveal).click());
  expect(props.onReveal).toHaveBeenLastCalledWith("/output/Custom.pdf");
  expect(host.querySelector('[role="alert"]')).toBeNull(); expect(props.onRun).toHaveBeenCalledTimes(1);
});

it("번호·머리글 옵션 변경은 고정된 문서 내용과 함께 전달한다", async () => {
  await render(); props.pageNumbers = false; props.pdfHeader = false; await render();
  await act(async () => runButton().click());
  const doc = vi.mocked(props.onRun).mock.calls[0][2];
  expect(doc.text).toBe("# Original"); expect(doc.pageNumbers).toBe(false); expect(doc.header).toBe(false);
  expect(doc.docxStyle.pageNumbers).toBe(false);
});

it("선택된 문서가 없으면 저장을 실행하지 않는다", async () => {
  props.capture = () => null; await render(); expect(runButton().disabled).toBe(true);
  expect(host.textContent).toContain(t.emptyNoDoc); expect(props.onRun).not.toHaveBeenCalled();
});

it("패널이 해제된 뒤 늦은 저장 응답은 다른 화면을 닫거나 갱신하지 않는다", async () => {
  let finish!: (result: ExportResult) => void;
  vi.mocked(props.onRun).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await render(); act(() => runButton().click());
  act(() => root.render(<p>Other screen</p>));
  await act(async () => finish({ status: "saved", path: "/output/Late.pdf" }));
  expect(host.textContent).toBe("Other screen"); expect(props.onCancel).not.toHaveBeenCalled();
});
