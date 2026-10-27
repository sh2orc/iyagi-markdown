// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { manageOverlayFocus } from "./overlayFocus";

let root: HTMLDivElement;
let stop: (() => void) | undefined;
beforeEach(() => {
  root = document.createElement("div");
  document.body.append(root);
  // jsdom has no layout; visibility and native disabled/inert checks still run.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return (this.isConnected ? [{ width: 100, height: 30 }] : []) as unknown as DOMRectList;
  });
});
afterEach(async () => {
  stop?.(); stop = undefined;
  root.remove();
  await Promise.resolve();
  vi.restoreAllMocks();
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function element(id: string) { return root.querySelector<HTMLElement>(`#${id}`)!; }
function tab(shiftKey = false) {
  const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(event);
  return event;
}

it("초기 포커스를 가져오고 disabled fieldset·숨김·음수 tabindex를 건너뛴다", () => {
  root.innerHTML = '<button id="opener">Open</button><div class="overlay">'
    + '<fieldset disabled><input id="disabled-field"></fieldset><select disabled></select>'
    + '<button hidden>Hidden</button><button tabindex="-1">Option</button>'
    + '<input id="first"><button id="last">Close</button></div>';
  element("opener").focus();
  stop = manageOverlayFocus(root, element("opener"), vi.fn());
  expect(document.activeElement).toBe(element("first"));
  tab(true);
  expect(document.activeElement).toBe(element("last"));
  tab();
  expect(document.activeElement).toBe(element("first"));
  element("opener").focus();
  expect(document.activeElement).toBe(element("first"));
});

it("컨트롤이 없는 진행 창도 Tab을 가두고 작업 중 비활성화된 포커스를 옮긴다", async () => {
  root.innerHTML = '<div class="overlay" id="busy"><button id="save">Save</button></div>';
  stop = manageOverlayFocus(root, null, vi.fn());
  (element("save") as HTMLButtonElement).disabled = true;
  await flush();
  expect(document.activeElement).toBe(element("busy"));
  expect(tab().defaultPrevented).toBe(true);
  expect(tab(true).defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(element("busy"));
});

it("DOM 순서보다 화면 레이어를 우선하고 상위 창이 닫히면 하위 창 선택을 복구한다", async () => {
  root.innerHTML = '<div class="overlay" id="base" style="z-index:60">'
    + '<button id="first">First</button><input id="editing"></div>';
  stop = manageOverlayFocus(root, null, vi.fn());
  element("editing").focus();
  const image = document.createElement("div");
  image.id = "image";
  image.setAttribute("aria-modal", "true");
  image.style.zIndex = "85";
  image.innerHTML = '<button id="image-close">Close image</button>';
  root.prepend(image);
  await flush();
  expect(document.activeElement).toBe(element("image-close"));
  image.remove();
  await flush();
  expect(document.activeElement).toBe(element("editing"));
});

it("대화상자 교체와 자체 초기 포커스를 존중한다", async () => {
  root.innerHTML = '<div class="overlay"><input id="initial"><input id="chosen"></div>';
  element("chosen").focus();
  stop = manageOverlayFocus(root, null, vi.fn());
  expect(document.activeElement).toBe(element("chosen"));
  root.innerHTML = '<div class="overlay"><button id="replacement">Export</button></div>';
  await flush();
  expect(document.activeElement).toBe(element("replacement"));
});

it("창이 닫히고 inert가 해제되면 편집기 대신 원래 버튼으로 복귀한다", async () => {
  root.innerHTML = '<div id="background"><button id="opener">Settings</button></div>'
    + '<div class="overlay"><button>Close</button></div>';
  const opener = element("opener");
  opener.focus();
  const fallback = vi.fn();
  stop = manageOverlayFocus(root, opener, fallback);
  element("background").setAttribute("inert", "");
  root.querySelector(".overlay")!.remove();
  stop(); stop = undefined;
  element("background").removeAttribute("inert");
  await flush();
  expect(document.activeElement).toBe(opener);
  expect(fallback).not.toHaveBeenCalled();
});

it("명시적으로 이동한 다음 작업의 포커스를 빼앗지 않는다", async () => {
  root.innerHTML = '<button id="opener">Open</button><input id="destination">'
    + '<div class="overlay"><button>Close</button></div>';
  stop = manageOverlayFocus(root, element("opener"), vi.fn());
  root.querySelector(".overlay")!.remove();
  stop(); stop = undefined;
  element("destination").focus();
  await flush();
  expect(document.activeElement).toBe(element("destination"));
});

it("사라진 열기 버튼은 건너뛰고 편집기로 복귀한다", async () => {
  root.innerHTML = '<button id="opener">Open</button><div class="overlay"><button>Close</button></div>';
  const opener = element("opener"), fallback = vi.fn();
  stop = manageOverlayFocus(root, opener, fallback);
  opener.remove();
  root.querySelector(".overlay")!.remove();
  stop(); stop = undefined;
  await flush();
  expect(fallback).toHaveBeenCalledTimes(1);
});

it("선택한 라디오 버튼 하나만 Tab 순서에 포함한다", () => {
  root.innerHTML = '<div class="overlay"><input type="radio" name="paper" id="a">'
    + '<input type="radio" name="paper" id="b" checked><button id="close">Close</button></div>';
  stop = manageOverlayFocus(root, null, vi.fn());
  expect(document.activeElement).toBe(element("b"));
  tab(); expect(document.activeElement).toBe(element("close"));
  tab(); expect(document.activeElement).toBe(element("b"));
});
