// 들여쓰기 가이드 단위 테스트 — 단계 계산(순수)·장식 범위·코드펜스 제외.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";

import { indentGuidePlugin, indentLevelOf } from "./indentGuide";
import { createDocState } from "./cm";

describe("indentLevelOf (순수)", () => {
  it("2공백당 1단계, 홀수 공백은 절삭", () => {
    expect(indentLevelOf("- a")).toBe(0);
    expect(indentLevelOf("  - b")).toBe(1);
    expect(indentLevelOf("    - c")).toBe(2);
    expect(indentLevelOf("   odd")).toBe(1); // 3공백 → 1
    expect(indentLevelOf("")).toBe(0);
  });
});

describe("indentGuidePlugin (장식)", { retry: 1 }, () => {
  const guidesOf = async (doc: string, mode: "edit" | "read"): Promise<[number, number][]> => {
    const view = new EditorView({ state: createDocState(doc, mode), parent: document.body });
    await new Promise((r) => setTimeout(r, 30)); // 초기 파싱·장식 반영 대기
    const plugin = view.plugin(indentGuidePlugin);
    const got: [number, number][] = [];
    if (plugin) {
      const c = plugin.guides.iter();
      while (c.value) {
        got.push([c.from, c.to]);
        c.next();
      }
    }
    view.destroy();
    return got;
  };

  it("중첩 목록의 선행 공백에만 마크 — 최상위·펜스 내부는 제외", async () => {
    const doc = "- a\n  - b\n    - c\n\n```js\n  const x = 1\n```\n";
    // "  - b" 줄 시작 4(공백 4..5), "    - c" 줄 시작 10(공백 10..13).
    expect(await guidesOf(doc, "edit")).toEqual([
      [4, 6],
      [10, 14],
    ]);
  });

  it("읽기 모드에서는 가이드 없음", async () => {
    expect(await guidesOf("- a\n  - b\n", "read")).toEqual([]);
  });
});
