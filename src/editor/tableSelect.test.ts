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

describe("빈 셀 행 높이 보존", { retry: 1 }, () => {
  it("새로 삽입한 빈 행의 셀도 줄 상자(nbsp)를 갖는다", async () => {
    const view = await tableView();
    let target: TableMenuTarget | null = null;
    setTableMenuHandler((tg) => {
      target = tg;
    });
    // (1행1열) 셀에서 '아래에 행 삽입' → 둘째 데이터 행이 빈 행.
    cells(view)[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    target!.run("row-below");
    await new Promise((r) => setTimeout(r, 20));
    const rows = view.dom.querySelectorAll(".md-table tbody tr");
    expect(rows.length).toBe(3);
    for (const td of Array.from(rows[1]!.children)) {
      expect(td.textContent).toBe("\u00A0"); // 빈 td가 아니라 줄 상자 있는 셀
    }
    setTableMenuHandler(null);
    view.destroy();
  });
});

describe("셀 병합 렌더·오퍼레이션", { retry: 1 }, () => {
  it("마커 표는 colspan/rowspan으로 렌더 — 고스트 셀 없음", async () => {
    const view = await tableView("| h | k |\n|---|---|\n| a | > |\n| ^ | x |\n");
    const trs = view.dom.querySelectorAll(".md-table tbody tr");
    expect(trs.length).toBe(2);
    const first = trs[0]!;
    expect(first.children.length).toBe(1); // ">" 고스트 스킵
    const master = first.children[0] as HTMLTableCellElement;
    expect(master.colSpan).toBe(2); // ">" 흡수
    expect(master.rowSpan).toBe(2); // "^" 흡수
    expect(master.textContent).toBe("a");
    expect(trs[1]!.children.length).toBe(1); // "^" 고스트 스킵 — x만
    expect((trs[1]!.children[0] as HTMLElement).textContent).toBe("x");
    view.destroy();
  });

  it("선택 병합 오퍼레이션 — 원문에 마커 반영", async () => {
    const view = await tableView();
    let target: TableMenuTarget | null = null;
    setTableMenuHandler((tg) => {
      target = tg;
    });
    const cs = cells(view);
    cs[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    cs[1]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await new Promise((r) => setTimeout(r, 15));
    cs[1]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    target!.run("merge");
    await new Promise((r) => setTimeout(r, 20));
    const doc = view.state.doc.toString();
    expect(doc).toContain("1 2");
    expect(doc).toContain("> |");
    setTableMenuHandler(null);
    view.destroy();
  });
});

describe("표 키보드 선택·메뉴(⇧화살표·메뉴 키)", { retry: 1 }, () => {
  it("⇧화살표 — 선택을 키보드로 확장(엑셀 확장 선택)", async () => {
    const view = await tableView();
    const cs = cells(view);
    cs[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    cs[1]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await new Promise((r) => setTimeout(r, 15));
    expect(selected(view).length).toBe(2); // (1행 1열)→(1행 2열)
    const wrap = view.dom.querySelector(".md-table-wrap")!;
    wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(selected(view).length).toBe(4); // 2×2로 확장(앵커 고정)
    view.destroy();
  });

  it("⇧화살표 — 그리드 경계 클램프(마지막 열·행)", async () => {
    const view = await tableView();
    const cs = cells(view);
    cs[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    cs[1]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await new Promise((r) => setTimeout(r, 15));
    const wrap = view.dom.querySelector(".md-table-wrap")!;
    wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(selected(view).length).toBe(2); // 마지막 열 — 그대로
    wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(selected(view).length).toBe(4); // 액티브 모서리가 헤더 행으로 확장(앵커는 r=1)
    view.destroy();
  });

  it("메뉴 키(⇧F10) — 표 메뉴 타깃 호출·병합 실행", async () => {
    const view = await tableView();
    let target: TableMenuTarget | null = null;
    setTableMenuHandler((tg) => {
      target = tg;
    });
    const cs = cells(view);
    cs[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    cs[3]!.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    await new Promise((r) => setTimeout(r, 15));
    const wrap = view.dom.querySelector(".md-table-wrap")!;
    wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 5));
    expect(target).not.toBeNull();
    expect(target!.row).toBe(2); // 활성 모서리(드래그 끝 셀)
    expect(target!.col).toBe(1);
    target!.run("merge"); // 키보드 경로로 병합까지
    await new Promise((r) => setTimeout(r, 20));
    expect(view.state.doc.toString()).toContain("1 2");
    setTableMenuHandler(null);
    view.destroy();
  });
});
