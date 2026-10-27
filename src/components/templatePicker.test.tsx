// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeT } from "../i18n";
import { TemplatePicker } from "./TemplatePicker";

const renderer = vi.hoisted(() => vi.fn());
vi.mock("../export/html", () => ({ renderExportBody: renderer }));
let host: HTMLDivElement, root: Root, props: ComponentProps<typeof TemplatePicker>;
const t = makeT("en");
beforeEach(() => {
  renderer.mockReset().mockResolvedValue("<h1>Rendered preview</h1>");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = { t, theme: "light", onCreate: vi.fn(), onClose: vi.fn() };
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
async function render() { await act(async () => root.render(<TemplatePicker {...props} />)); }
function input() { return host.querySelector<HTMLInputElement>('input[type="search"]')!; }
function button(label: string) { return [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === label)!; }
function choice(label: string) { return [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.querySelector("strong")?.textContent === label)!; }
async function search(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(target: Element, value: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(event); }); return event;
}

it("템플릿 선택·미리보기·취소는 문서를 생성하지 않는다", async () => {
  props.initialId = "meeting"; await render();
  expect(document.activeElement).toBe(input());
  expect(choice("Meeting Notes").getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector(".template-preview")?.textContent).toBe("Rendered preview");
  await act(async () => choice("Project Brief").click());
  expect(renderer.mock.calls.at(-1)?.[0]).toContain("## Milestones and owners");
  await act(async () => button(t.cancel).click());
  expect(props.onCreate).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("한글 조합형 검색과 검색 결과 없음, 검색 해제 뒤의 선택을 처리한다", async () => {
  props.t = makeT("ko"); await render();
  await search("프로젝트".normalize("NFD"));
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(1);
  expect(choice("프로젝트 계획").getAttribute("aria-checked")).toBe("true");
  await search("");
  expect(choice("프로젝트 계획").getAttribute("aria-checked")).toBe("true");
  await search("no such template zzzz");
  expect(host.textContent).toContain(props.t.templateEmpty);
  expect(button(props.t.templateCreate).disabled).toBe(true);
  expect(host.querySelector(".template-preview")).toBeNull();
});

it("화살표로 선택하고 IME 중에는 선택·닫기·생성을 하지 않는다", async () => {
  await render(); await key(input(), "ArrowDown");
  expect(document.activeElement).toBe(choice("Blank"));
  await key(choice("Blank"), "ArrowDown");
  expect(document.activeElement).toBe(choice("Report"));
  await key(choice("Report"), "ArrowDown", { isComposing: true });
  expect(choice("Report").getAttribute("aria-checked")).toBe("true");
  await key(input(), "Escape", { isComposing: true });
  expect(props.onClose).not.toHaveBeenCalled();
  act(() => input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await act(async () => button(t.templateCreate).click());
  expect(props.onCreate).not.toHaveBeenCalled();
  act(() => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await key(input(), "Escape"); expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("이전 선택의 늦은 미리보기 응답은 새 선택을 덮어쓰지 않는다", async () => {
  let finish!: (html: string) => void;
  renderer.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve; }));
  props.initialId = "report"; await render();
  await act(async () => choice("Meeting Notes").click());
  expect(host.querySelector(".template-preview")?.textContent).toBe("Rendered preview");
  await act(async () => finish("<h1>Stale report</h1>"));
  expect(host.textContent).not.toContain("Stale report");
});

it("미리보기 실패에도 원문과 생성 기능을 제공하며 생성 시점 날짜로 한 번만 만든다", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 21, 23, 59));
  renderer.mockRejectedValue(new Error("renderer unavailable"));
  props.initialId = "meeting"; await render();
  expect(host.textContent).toContain(t.templatePreviewFailed);
  expect(host.querySelector(".template-source")?.textContent).toContain("date: 2026-10-21");
  vi.setSystemTime(new Date(2026, 9, 22, 0, 1));
  await act(async () => { button(t.templateCreate).click(); button(t.templateCreate).click(); });
  expect(props.onCreate).toHaveBeenCalledTimes(1);
  expect(props.onCreate).toHaveBeenCalledWith(expect.stringContaining("date: 2026-10-22"));
  expect(props.onCreate).toHaveBeenCalledWith(expect.stringContaining("## Agenda"));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("생성 실패 시 선택을 보존하고 재시도를 허용한다", async () => {
  props.initialId = "project";
  props.onCreate = vi.fn().mockImplementationOnce(() => { throw new Error("creation failed"); });
  await render(); await act(async () => button(t.templateCreate).click());
  expect(host.textContent).toContain(t.templateCreateFailed);
  expect(choice("Project Brief").getAttribute("aria-checked")).toBe("true");
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => button(t.templateCreate).click());
  expect(props.onCreate).toHaveBeenCalledTimes(2); expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("언어를 바꾸면 이름·본문을 갱신하고 원문 보기에서도 같은 템플릿을 유지한다", async () => {
  props.initialId = "weekly"; await render();
  await act(async () => button(t.templateSource).click());
  expect(host.querySelector(".template-source")?.textContent).toContain("## Priorities");
  props.t = makeT("ko"); await render();
  expect(choice("주간 계획").getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector(".template-source")?.textContent).toContain("## 이번 주 우선순위");
});
