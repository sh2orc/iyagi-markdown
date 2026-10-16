// 표 셀 다중 선택(DOM) — 드래그·⇧클릭 선택, Delete 비우기, 우클릭 메뉴 다리.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";

import { createDocState } from "./cm";
import { setTableMenuHandler, type TableMenuTarget } from "./widgets";

const DOC = "| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n";

async function tableView(doc = DOC): Promise<EditorView> {
  const view = new EditorView({ state: createDocState(doc, "edit"), parent: document.body });
  await new Promise((r) => setTimeout(r, 40)); // 위젯 마운트
  return view;
}

const cells = (view: EditorView) => Array.from(view.dom.querySelectorAll(".md-table tbody td")) as HTMLElement[];
const selected = (view: EditorView): HTMLElement[] =>
  Array.from(view.dom.querySelectorAll(".md-cell-selected")) as HTMLElement[];

describe("표 셀 다중 선택", { retry: 1 }, () => {
  it("드래그 — 두 셀에 걸쳐 사각 선택(클릭=편집 예약 취소)", async () => {
    const view = await tableView();
    const cs = cells(view);
    cs[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    cs[3]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await new Promise((r) => setTimeout(r, 15));
    const sel = selected(view);
    expect(sel.length).toBe(4); // (1행1열)→(2행2열): 2×2 사각
    expect(sel.map((el) => el.textContent)).toEqual(["1", "2", "3", "4"]);
    view.destroy();
  });

  it("Delete — 선택 셀 내용 비우기(원문 재직렬화)", async () => {
    const view = await tableView();
    const cs = cells(view);
    cs[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    cs[1]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await new Promise((r) => setTimeout(r, 15));
    view.dom.querySelector(".md-table-wrap")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 15));
    expect(view.state.doc.toString()).toContain("|  |  |");
    view.destroy();
  });

  it("우클릭 — 메뉴 다리 호출·연산 실행(행 삽입)", async () => {
    const view = await tableView();
    let target: TableMenuTarget | null = null;
    setTableMenuHandler((tg) => {
      target = tg;
    });
    cells(view)[2]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(target).not.toBeNull();
    expect(target!.rows).toBe(3);
    expect(target!.row).toBe(2);
    target!.run("row-below");
    await new Promise((r) => setTimeout(r, 15));
    expect(view.state.doc.toString()).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n|  |  |\n");
    setTableMenuHandler(null);
    view.destroy();
  });

  it("⇧클릭 — 선택 확장·축소(앵커 유지)", async () => {
    const view = await tableView();
    const cs = cells(view);
    cs[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    cs[3]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await new Promise((r) => setTimeout(r, 15));
    cs[3]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, shiftKey: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(selected(view).length).toBe(4); // 앵커(1,1)→(2,2) 그대로 2×2
    cs[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, shiftKey: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(selected(view).length).toBe(2); // 앵커(1,1)→(1,2)로 축소 — 같은 행 2셀
    view.destroy();
  });
});
