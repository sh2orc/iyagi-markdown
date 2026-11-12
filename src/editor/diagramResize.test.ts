// mermaid 다이어그램 크기 조절 — 드래그로 폭(%) 저장, 사이드카 반영 시 DOM 유지,
// 핸들 클릭이 '클릭=편집'으로 새지 않음, 더블클릭 = 전체 폭.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../plugins/mermaid", () => ({
  renderMermaid: async () => ({
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50" width="100%" height="50" style="max-width: 100px;"></svg>',
    error: null,
  }),
}));

import { EditorView } from "@codemirror/view";
import { createDocState } from "./cm";
import { diagramKey } from "./diagramKey";
import { setPreviewConfig } from "./livePreview";
import { setDiagramResizeHandler } from "./widgets";

const CODE = "graph TD;\nA-->B;";
const DOC = `# 제목\n\n\`\`\`mermaid\n${CODE}\n\`\`\`\n\n끝\n`;

function config(diagramWidths: Record<string, number>) {
  return setPreviewConfig.of({
    baseDir: "/tmp", remoteImages: true, showImages: true, theme: "light",
    imageWidths: {}, bookmarks: [], tableWidths: {}, diagramWidths, wikiIndex: new Map(),
  });
}

async function makeView(diagramWidths: Record<string, number> = {}): Promise<EditorView> {
  const view = new EditorView({ state: createDocState(DOC, "edit"), parent: document.body });
  view.dispatch({ effects: config(diagramWidths) });
  await new Promise((r) => setTimeout(r, 150));
  return view;
}

afterEach(() => {
  setDiagramResizeHandler(null);
  document.body.innerHTML = "";
});

it("드래그해 놓으면 코드 키와 줄어든 폭(%)으로 저장한다", async () => {
  const saved: Array<[string, number]> = [];
  setDiagramResizeHandler((key, pct) => saved.push([key, pct]));
  const view = await makeView();
  const wrap = document.querySelector(".md-diagram") as HTMLElement;
  const box = wrap.querySelector(".md-diagram-box") as HTMLElement;
  const handle = wrap.querySelector(".md-diagram-handle") as HTMLElement;
  expect(handle).not.toBeNull();
  expect(box.style.width).toBe("100%");
  // jsdom은 clientWidth가 0 — 상자 % 기준 폭을 정해 둔다(패딩 포함 값).
  Object.defineProperty(wrap, "clientWidth", { configurable: true, value: 524 });
  handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 500, button: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 400 }));
  window.dispatchEvent(new MouseEvent("pointerup", { clientX: 400 }));
  expect(saved).toHaveLength(1);
  const [key, pct] = saved[0]!;
  expect(key).toBe(diagramKey(CODE));
  expect(pct).toBeGreaterThanOrEqual(10);
  expect(pct).toBeLessThan(100);
  expect(box.style.width).toBe(`${pct}%`);
  view.destroy();
});

it("사이드카 폭이 바뀌면 다시 그리지 않고 같은 DOM의 폭만 고친다", async () => {
  const view = await makeView({ [diagramKey(CODE)]: 60 });
  const wrap = document.querySelector(".md-diagram") as HTMLElement;
  const box = wrap.querySelector(".md-diagram-box") as HTMLElement;
  expect(box.style.width).toBe("60%");
  view.dispatch({ effects: config({ [diagramKey(CODE)]: 30 }) });
  await new Promise((r) => setTimeout(r, 80));
  expect(document.querySelector(".md-diagram")).toBe(wrap);
  expect(box.style.width).toBe("30%");
  expect(wrap.querySelector("svg")).not.toBeNull();
  view.destroy();
});

it("핸들 mousedown은 커서를 코드로 옮기지 않고, 더블클릭은 전체 폭으로 저장한다", async () => {
  const saved: Array<[string, number]> = [];
  setDiagramResizeHandler((key, pct) => saved.push([key, pct]));
  const view = await makeView({ [diagramKey(CODE)]: 40 });
  const handle = document.querySelector(".md-diagram-handle") as HTMLElement;
  const before = view.state.selection.main.head;
  handle.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  expect(view.state.selection.main.head).toBe(before);
  handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  expect(saved).toEqual([[diagramKey(CODE), 100]]);
  view.destroy();
});

/** 커서(선택)가 펜스 줄(3~5줄)에 걸쳐 있는가 — 걸치면 원문이 노출된다. */
function touchesFence(view: EditorView): boolean {
  return view.state.selection.ranges.some((r) => {
    const a = view.state.doc.lineAt(r.from).number;
    const b = view.state.doc.lineAt(r.to).number;
    return a <= 5 && b >= 3;
  });
}

it("편집 모드에서 클릭하면 원문 대신 선택(크기 조절) 상태가 되고, 바깥 클릭·Esc로 풀린다", async () => {
  const view = await makeView();
  const wrap = document.querySelector(".md-diagram") as HTMLElement;
  wrap.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  expect(document.querySelector(".md-diagram")).toBe(wrap); // 원문으로 물러나지 않음
  expect(wrap.classList.contains("md-diagram-selected")).toBe(true);
  expect(touchesFence(view)).toBe(false);
  document.body.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
  expect(wrap.classList.contains("md-diagram-selected")).toBe(false);
  wrap.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(wrap.classList.contains("md-diagram-selected")).toBe(false);
  view.destroy();
});

it("범위 선택이 있을 때 클릭해도 펜스 바깥으로 접혀 원문이 노출되지 않는다", async () => {
  const view = await makeView();
  const last = view.state.doc.length;
  view.dispatch({ selection: { anchor: last - 2, head: last } }); // '끝' 줄 범위 선택
  await new Promise((r) => setTimeout(r, 30));
  const wrap = document.querySelector(".md-diagram") as HTMLElement;
  // contentDOM 캡처(widgetClickCollapse)부터 거치도록 실제 경로로 보낸다.
  wrap.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  expect(view.state.selection.main.empty).toBe(true);
  expect(touchesFence(view)).toBe(false);
  expect(document.querySelector(".md-diagram")).toBe(wrap);
  view.destroy();
});

it("더블클릭·'코드 편집' 버튼은 원문 편집으로 전환한다", async () => {
  const view = await makeView();
  let wrap = document.querySelector(".md-diagram") as HTMLElement;
  wrap.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  expect(touchesFence(view)).toBe(true);
  expect(document.querySelector(".md-diagram")).toBeNull(); // 원문 노출

  // 커서를 밖으로 빼면 다시 렌더 — 이번엔 버튼으로.
  view.dispatch({ selection: { anchor: 0 } });
  await new Promise((r) => setTimeout(r, 150));
  wrap = document.querySelector(".md-diagram") as HTMLElement;
  const edit = wrap.querySelector(".md-diagram-edit") as HTMLButtonElement;
  expect(edit).not.toBeNull();
  edit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 30));
  expect(touchesFence(view)).toBe(true);
  view.destroy();
});
