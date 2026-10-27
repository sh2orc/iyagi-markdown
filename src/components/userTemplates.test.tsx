// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type UserTemplate, type UserTemplateList } from "../api";
import { makeT } from "../i18n";
import { UserTemplateEditor, type TemplateDraft } from "./UserTemplateEditor";
import { TemplatePicker } from "./TemplatePicker";
import { UserTemplatePreview } from "./UserTemplatePreview";

const mocks = vi.hoisted(() => ({ listen: vi.fn(), render: vi.fn() }));
vi.mock("../api", async (original) => ({ ...await original<typeof import("../api")>(), isInApp: () => true, onUserTemplatesChanged: mocks.listen }));
vi.mock("../export/html", () => ({ renderExportBody: mocks.render }));
const t = makeT("en");
const original: UserTemplate = { id: "template-one", version: 1, name: "My meeting", description: "Personal agenda", content: "# Exact {{date}}\r\n![image](../assets/a.png)\r\n" };
let host: HTMLDivElement, root: Root, event: (revision: number) => void;
let close: ReturnType<typeof vi.fn>, saved: ReturnType<typeof vi.fn>, create: ReturnType<typeof vi.fn>;
function button(text: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => !item.disabled && item.textContent === text)!; }
function radio(name: string) { return [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.querySelector("strong")?.textContent === name)!; }
async function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function picker() { await act(async () => root.render(<TemplatePicker t={t} theme="light" onCreate={create} onClose={close} />)); }
async function editor(draft: TemplateDraft = { ...original, expectedVersion: original.version }) {
  await act(async () => root.render(<UserTemplateEditor draft={draft} t={t} onClose={close} onSaved={saved} />));
}
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  close = vi.fn(); saved = vi.fn().mockResolvedValue(undefined); create = vi.fn();
  mocks.listen.mockImplementation(async (handler: (revision: number) => void) => { event = handler; return vi.fn(); });
  mocks.render.mockResolvedValue('<h1>Preview</h1><a href="https://example.test">link</a><input type="checkbox" disabled="" checked=""><input type="checkbox" disabled="">');
  vi.spyOn(api, "listUserTemplates").mockResolvedValue({ revision: 1, templates: [original] });
  vi.spyOn(api, "getUserTemplate").mockResolvedValue(original);
  vi.spyOn(api, "putUserTemplate").mockImplementation(async (input) => ({ ...input, version: 2 }));
  vi.spyOn(api, "deleteUserTemplate").mockResolvedValue(undefined);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("목록은 본문을 읽지 않고 선택한 사용자 템플릿만 읽으며 원문 그대로 새 문서를 만든다", async () => {
  await picker(); expect(api.getUserTemplate).not.toHaveBeenCalled();
  await act(async () => radio("My meeting").click());
  await act(async () => {});  // 이중 비동기(getUserTemplate→render→dompurify→setPreview) 플러시
  expect(api.getUserTemplate).toHaveBeenCalledWith("template-one");
  const frame = await vi.waitFor(() => { const el = host.querySelector("iframe"); expect(el).not.toBeNull(); return el!; });
  expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
  expect(frame.srcdoc).toContain("default-src 'none'");
  expect(frame.srcdoc).not.toContain('href="https://example.test"');
  expect(frame.srcdoc).toContain("☑"); expect(frame.srcdoc).toContain("☐");
  expect(mocks.render).toHaveBeenLastCalledWith(original.content, expect.objectContaining({ renderDiagrams: false, inlineImages: false }));
  await act(async () => button(t.templateCreate).click());
  expect(create).toHaveBeenCalledWith(original.content);
});

it("다른 창에서 선택한 템플릿을 삭제하면 새 문서 생성을 막는다", async () => {
  await picker(); await act(async () => radio("My meeting").click());
  vi.mocked(api.listUserTemplates).mockResolvedValue({ revision: 2, templates: [] });
  await act(async () => event(2));
  expect(host.textContent).toContain(t.userTemplateUnavailable);
  expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === t.templateCreate)?.disabled).toBe(true);
  expect(create).not.toHaveBeenCalled();
});

it("본문 조회가 실패하면 생성하지 않고, 선택을 바꾼 뒤의 늦은 본문 응답은 무시한다", async () => {
  vi.mocked(api.getUserTemplate).mockRejectedValueOnce(new Error("read failed"));
  await picker(); await act(async () => radio("My meeting").click());
  expect(host.textContent).toContain(t.userTemplateFailed);
  expect([...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === t.templateCreate)?.disabled).toBe(true);
  let finish!: (value: UserTemplate) => void;
  vi.mocked(api.getUserTemplate).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => button(t.wsRetry).click());
  await act(async () => radio("Report").click());
  await act(async () => finish(original));
  await act(async () => button(t.templateCreate).click());
  expect(create).toHaveBeenCalledWith(expect.stringContaining("## Overview"));
  expect(create).not.toHaveBeenCalledWith(original.content);
});

it("이전 목록 요청의 늦은 실패는 새 변경 이벤트의 목록을 오류로 덮어쓰지 않는다", async () => {
  let reject!: (reason: unknown) => void;
  vi.mocked(api.listUserTemplates).mockImplementationOnce(() => new Promise<UserTemplateList>((_resolve, fail) => { reject = fail; }));
  await picker();
  vi.mocked(api.listUserTemplates).mockResolvedValue({ revision: 2, templates: [{ ...original, name: "Latest", version: 2 }] });
  await act(async () => event(2));
  await act(async () => reject(new Error("old read")));
  expect(radio("Latest")).toBeTruthy();
  expect(host.textContent).not.toContain(t.userTemplateLoadFailed);
});

it("삭제 확인은 확인한 버전을 보내고 충돌 시 목록을 보존한다", async () => {
  await picker(); await act(async () => radio("My meeting").click());
  await act(async () => button(t.userTemplateDelete).click());
  expect(api.deleteUserTemplate).not.toHaveBeenCalled();
  vi.mocked(api.deleteUserTemplate).mockRejectedValue({ code: "changed" });
  await act(async () => button(t.userTemplateDelete).click());
  expect(api.deleteUserTemplate).toHaveBeenCalledWith(original.id, 1);
  expect(host.textContent).toContain(t.userTemplateChanged);
  expect(radio("My meeting")).toBeTruthy();
});

it("편집 충돌 뒤 입력을 유지하고 별도 사본을 새 정체성으로 저장한다", async () => {
  await editor(); await change(host.querySelector("textarea")!, "My local edit");
  vi.mocked(api.putUserTemplate).mockRejectedValueOnce({ code: "changed" });
  await act(async () => button(t.userTemplateSave).click());
  expect(host.querySelector("textarea")?.value).toBe("My local edit");
  expect(host.textContent).toContain(t.userTemplateChanged); expect(saved).not.toHaveBeenCalled();
  await act(async () => button(t.userTemplateSaveCopy).click());
  const input = vi.mocked(api.putUserTemplate).mock.calls.at(-1)![0];
  expect(input.id).not.toBe(original.id); expect(input.expectedVersion).toBeNull();
  expect(input.content).toBe("My local edit"); expect(saved).toHaveBeenCalledTimes(1);
});

it("저장 중 중복 클릭·Escape를 막고 실패 후 동일한 정체성으로 재시도한다", async () => {
  let reject!: (reason: unknown) => void;
  vi.mocked(api.putUserTemplate).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await editor({ ...original, expectedVersion: null });
  const save = button(t.userTemplateSave);
  await act(async () => { save.click(); save.click(); });
  await act(async () => host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(api.putUserTemplate).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
  await act(async () => reject(new Error("lost response")));
  await act(async () => button(t.userTemplateSave).click());
  expect(vi.mocked(api.putUserTemplate).mock.calls[1][0].id).toBe(original.id);
});

it("입력 취소는 폐기 확인을 거치며 IME Escape는 닫기로 처리하지 않는다", async () => {
  await editor(); await change(host.querySelector("textarea")!, "unsaved");
  await act(async () => host.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
  expect(host.textContent).not.toContain(t.userTemplateDiscard);
  await act(async () => button(t.cancel).click());
  expect(close).not.toHaveBeenCalled(); expect(host.textContent).toContain(t.userTemplateDiscard);
  await act(async () => button(t.userTemplateKeepEditing).click());
  expect(host.querySelector("textarea")?.value).toBe("unsaved");
});

it("분리된 미리보기의 Escape를 부모 모달에 전달하고 닫힌 뒤에는 전달하지 않는다", async () => {
  await act(async () => root.render(<div onKeyDown={(event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
  }}><UserTemplatePreview html="<p>Preview</p>" title="Preview" theme="light" /></div>));
  const frame = host.querySelector("iframe")!;
  await act(async () => { frame.dispatchEvent(new Event("load")); });
  const doc = frame.contentDocument!;
  const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => { doc.dispatchEvent(key); });
  expect(key.defaultPrevented).toBe(true); expect(close).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(close).toHaveBeenCalledTimes(1);
});
