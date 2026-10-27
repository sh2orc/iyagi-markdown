// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { connectPrintFrame } from "./printFrame";
let cleanup = () => {};
afterEach(() => { cleanup(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function fixture() {
  const frame = document.createElement("iframe"); document.body.append(frame);
  const scrollTo = vi.spyOn(frame.contentWindow!, "scrollTo").mockImplementation(() => {});
  const ready = vi.fn(), error = vi.fn(), scroll = { current: 120 };
  return { frame, doc: frame.contentDocument!, scrollTo, ready, error, scroll };
}

it("글꼴 준비 뒤에만 인쇄를 허용하고 닫은 프레임의 늦은 완료는 무시한다", async () => {
  const f = fixture();
  let finish!: () => void;
  Object.defineProperty(f.doc, "fonts", { value: { ready: new Promise<void>((resolve) => { finish = resolve; }) } });
  cleanup = connectPrintFrame(f.frame, f.scroll, f.ready, f.error);
  expect(f.ready).not.toHaveBeenCalled();
  finish(); await Promise.resolve();
  expect(f.ready).toHaveBeenCalledTimes(1); expect(f.scrollTo).toHaveBeenCalledWith(0, 120);
  cleanup(); f.ready.mockClear();
  cleanup = connectPrintFrame(f.frame, f.scroll, f.ready, f.error);
  cleanup(); await Promise.resolve(); expect(f.ready).not.toHaveBeenCalled();
});

it("Tab·Escape를 부모에 전달하고 IME·다른 키와 해제 뒤 이벤트는 전달하지 않는다", async () => {
  const f = fixture(), parent = vi.fn((event: KeyboardEvent) => event.preventDefault());
  f.frame.addEventListener("keydown", parent);
  cleanup = connectPrintFrame(f.frame, f.scroll, f.ready, f.error);
  const key = (name: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
    f.doc.dispatchEvent(event); return event;
  };
  expect(key("Escape").defaultPrevented).toBe(true);
  expect(key("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
  expect(parent.mock.calls[1][0].shiftKey).toBe(true);
  key("Escape", { isComposing: true }); key("Escape", { keyCode: 229 }); key("a");
  expect(parent).toHaveBeenCalledTimes(2);
  cleanup(); key("Escape"); expect(parent).toHaveBeenCalledTimes(2);
});

it("외부 링크로 미리보기가 바뀌지 않게 하고 내부 목차 이동은 허용한다", () => {
  const f = fixture(); cleanup = connectPrintFrame(f.frame, f.scroll, f.ready, f.error);
  f.doc.body.innerHTML = '<a href="https://example.com">External</a><a href="#heading">Internal</a>';
  const links = f.doc.querySelectorAll("a");
  const external = new MouseEvent("click", { bubbles: true, cancelable: true });
  links[0].dispatchEvent(external); expect(external.defaultPrevented).toBe(true);
  // Dispatch from the document with an anchor target to inspect the listener without navigation.
  const internal = new MouseEvent("click", { bubbles: true, cancelable: true });
  Object.defineProperty(internal, "target", { value: links[1] });
  f.doc.dispatchEvent(internal); expect(internal.defaultPrevented).toBe(false);
});
