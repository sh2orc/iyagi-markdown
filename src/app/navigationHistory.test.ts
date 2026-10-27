import { ChangeSet, EditorSelection } from "@codemirror/state";
import { expect, it } from "vitest";
import { NavigationHistory, type NavigationPoint } from "./navigationHistory";

const point = (tabId: string, pos = 0): NavigationPoint => ({
  tabId, selection: EditorSelection.single(pos), scroll: pos * 10, outerScroll: null,
});

it("뒤로·앞으로 이동과 새 목적지 분기를 분리한다", () => {
  const history = new NavigationHistory();
  history.visit(point("a", 2)); history.visit(point("b", 4));
  expect(history.travel(false, point("c", 6))?.tabId).toBe("b");
  expect(history.travel(false, point("b", 4))?.selection.main.head).toBe(2);
  expect(history.canBack).toBe(false);
  expect(history.travel(true, point("a", 2))?.tabId).toBe("b");
  history.visit(point("b", 4));
  expect(history.canForward).toBe(false);
  expect(history.travel(false, point("d"))?.tabId).toBe("b");
});

it("닫힌 문서와 자동 선택된 현재 위치를 기록에서 제외한다", () => {
  const history = new NavigationHistory();
  history.visit(point("a")); history.visit(point("b")); history.visit(point("c"));
  history.remove("b"); history.discardCurrent(point("c"));
  expect(history.travel(false, point("c"))?.tabId).toBe("a");
  expect(history.canBack).toBe(false);
  history.remove("c"); expect(history.canForward).toBe(false);
});

it("편집은 양쪽 기록의 선택 범위를 보정하고 픽셀 스크롤을 폐기한다", () => {
  const history = new NavigationHistory();
  history.visit({ ...point("a"), selection: EditorSelection.single(8, 4) });
  history.visit(point("a", 12));
  history.travel(false, point("a", 18));
  history.map("a", ChangeSet.of({ from: 0, insert: "prefix " }, 20));
  const back = history.travel(false, null)!;
  expect([back.selection.main.anchor, back.selection.main.head]).toEqual([15, 11]);
  expect(back.scroll).toBeNull();
  const forward = history.travel(true, null)!;
  expect(forward.selection.main.head).toBe(25);
  expect(forward.scroll).toBeNull();
});

it("중복 목적지를 합치고 기록을 100개로 제한하며 다시 읽기 위치를 제한한다", () => {
  const history = new NavigationHistory();
  for (let i = 0; i < 150; i++) history.visit(point("a", i));
  history.visit(point("a", 149));
  history.invalidate("a", 5);
  let count = 0, entry: NavigationPoint | null;
  while ((entry = history.travel(false, null))) {
    expect(entry.selection.main.head).toBeLessThanOrEqual(5);
    expect(entry.scroll).toBeNull(); count++;
  }
  expect(count).toBe(100);
});
