// 드래그 중 위젯 파괴 — window 청취기 누수 회귀(이미지 폭·표 열 폭).
// @vitest-environment jsdom
import { expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { createDocState } from "./cm";
import { setPreviewConfig } from "./livePreview";

async function makeView(text: string): Promise<EditorView> {
  const view = new EditorView({ state: createDocState(text, "edit"), parent: document.body });
  view.dispatch({
    effects: setPreviewConfig.of({
      baseDir: "/tmp", remoteImages: true, showImages: true, theme: "light",
      imageWidths: {}, bookmarks: [], tableWidths: {}, wikiIndex: new Map(),
    }),
  });
  await new Promise((r) => setTimeout(r, 120));
  // jsdom은 clientWidth가 항상 0 — 드래그 백분율 계산에 쓰일 폭을 정해 둔다.
  Object.defineProperty(view.contentDOM, "clientWidth", { configurable: true, value: 500 });
  return view;
}

it("이미지 폭 드래그 중 문서가 바뀌면 청취기를 떼고 값이 더 움직이지 않는다", async () => {
  // 로컬 그림은 앱 밖(테스트)에서 broken 경로 — 원격 그림이어야 핸들이 만들어진다.
  const view = await makeView("![alt](https://example.com/a.png)\n");
  const handle = document.querySelector(".md-img-handle") as HTMLElement;
  expect(handle).not.toBeNull();
  handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, bubbles: true }));
  // 줄이는 방향(100% 상한에 걸리지 않게) — 500px 대비 -80px = -16%.
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 20 }));
  const pct = Number(handle.dataset.pct ?? 0);
  expect(pct).toBeGreaterThan(0);
  expect(pct).toBeLessThan(100); // 클램프 천장이 아니라 실제 드래그 값
  // 드래그 중 문서 교체 — 위젯이 사라진 상태로 pointermove가 와도 누수가 없게.
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "끝" } });
  await new Promise((r) => setTimeout(r, 60));
  const frozen = handle.dataset.pct;
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: -900 }));
  await new Promise((r) => setTimeout(r, 10));
  expect(handle.dataset.pct).toBe(frozen);
  view.destroy();
  document.body.innerHTML = "";
});

it("표 열 폭 드래그도 문서가 바뀌면 청취기를 뗀다", async () => {
  const view = await makeView("| a | b |\n|---|---|\n| 1 | 2 |\n");
  const handle = document.querySelector(".md-col-handle") as HTMLElement;
  expect(handle).not.toBeNull();
  const col = document.querySelector(".md-table col") as HTMLElement;
  handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, bubbles: true }));
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 300 }));
  expect(col.style.width).not.toBe(""); // 드래그 중 폭이 움직인다
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "끝" } });
  await new Promise((r) => setTimeout(r, 60));
  const frozen = col.style.width;
  window.dispatchEvent(new MouseEvent("pointermove", { clientX: 480 }));
  await new Promise((r) => setTimeout(r, 10));
  expect(col.style.width).toBe(frozen); // 파괴 뒤 청취기가 남지 않았다
  view.destroy();
  document.body.innerHTML = "";
});

it("CM 본문 텍스트상자에 이름(aria-label)이 있다 — 'textbox'만 발음하지 않게", async () => {
  const view = await makeView("가\n");
  const label = view.contentDOM.getAttribute("aria-label");
  expect(label && label.trim().length).toBeGreaterThan(0);
  view.destroy();
  document.body.innerHTML = "";
});
