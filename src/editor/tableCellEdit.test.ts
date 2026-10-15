// 표 셀 제자리 편집 — 클릭·커밋·셀 간 이동(DOM 통합).
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";

import { createDocState } from "./cm";

const DOC = `| a | b |
|---|---|
| 1 | 2 |
| 3 | 4 |
`;

async function makeView(): Promise<EditorView> {
  const view = new EditorView({ state: createDocState(DOC, "read"), parent: document.body });
  await new Promise((r) => setTimeout(r, 120));
  return view;
}

function cells(): HTMLTableCellElement[][] {
  const table = document.querySelector(".md-table");
  expect(table).not.toBeNull();
  return Array.from(table!.querySelectorAll("tr")).map(
    (tr) => Array.from(tr.children) as HTMLTableCellElement[],
  );
}

const click = (el: Element) =>
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

describe("표 셀 제자리 편집(Word식)", { retry: 2 }, () => {
  it("클릭으로 편집 시작 → 값 반영(원문 재직렬화)", async () => {
    const view = await makeView();
    const td = cells()[1][0];
    click(td);
    await new Promise((r) => setTimeout(r, 20));
    expect(td.classList.contains("md-cell-editing")).toBe(true);
    td.textContent = "9";
    td.dispatchEvent(new FocusEvent("blur"));
    await new Promise((r) => setTimeout(r, 150));
    expect(view.state.doc.toString()).toContain("| 9 | 2 |");
    view.destroy();
  });

  it("편집 중 다른 셀 클릭 — 커밋 후 그 셀에서 이어 편집(클릭 삼킴 없음)", async () => {
    const view = await makeView();
    const grid = cells();
    click(grid[1][0]);
    await new Promise((r) => setTimeout(r, 20));
    grid[1][0].textContent = "7";
    // 편집 중 오른쪽 셀 클릭(캡처가 대상 기록) → blur 커밋 → 재생성 후 복원.
    click(grid[1][1]);
    grid[1][0].dispatchEvent(new FocusEvent("blur"));
    await new Promise((r) => setTimeout(r, 200));
    expect(view.state.doc.toString()).toContain("| 7 | 2 |");
    const next = cells();
    expect(next[1][1].classList.contains("md-cell-editing")).toBe(true);
    view.destroy();
  });
});
