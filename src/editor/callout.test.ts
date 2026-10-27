// 콜아웃(인용문 첫 줄 [!유형]) — 라이브 프리뷰 장식·유형 정규화.
// 원문은 그대로 인용문이라 다른 렌더러에서 무해하게 강등된다(§4-2).
// @vitest-environment jsdom

import { beforeAll, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";

import { createDocState } from "./cm";
import { __testing, setPreviewConfig } from "./livePreview";
import { CALLOUT_TYPES, calloutKeyOf } from "./widgets";

const PREVIEW = setPreviewConfig.of({
  baseDir: "/tmp",
  remoteImages: true,
  showImages: true,
  theme: "light",
  imageWidths: {},
  bookmarks: [],
  tableWidths: {},
  wikiIndex: new Map(),
});

async function mount(doc: string): Promise<EditorView> {
  const view = new EditorView({ state: createDocState(doc, "edit"), parent: document.body });
  view.dispatch({ effects: PREVIEW });
  await new Promise((r) => setTimeout(r, 120));
  return view;
}

beforeAll(() => {
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
  }
});

it("별칭은 정식 유형으로 정규화한다", () => {
  expect(calloutKeyOf("tldr")).toBe("abstract");
  expect(calloutKeyOf("FAQ")).toBe("question");
  expect(calloutKeyOf("cite")).toBe("quote");
  expect(calloutKeyOf("알수없음")).toBe("note"); // 모르는 유형은 note로 강등
  // 정식 13종·별칭 포함 전수 회귀
  expect(Object.keys(CALLOUT_TYPES)).toHaveLength(27);
});

it("[!tip] 인용문이 콜아웃 카드로 꾸며진다 — 아이콘·제목·줄 클래스", async () => {
  const view = await mount("> [!tip] 캐시 규칙\n> 내용 줄입니다.\n");
  try {
    const icon = document.querySelector(".md-callout-icon");
    expect(icon?.textContent).toBe("💡");
    expect(icon?.className).toContain("md-callout-icon-tip");
    expect(document.body.innerHTML).toContain("md-callout md-callout-tip");
    // 제목 마크 장식 — 원문 텍스트는 그대로 있다.
    expect(view.state.doc.toString()).toContain("[!tip] 캐시 규칙");
  } finally {
    view.destroy();
    document.body.innerHTML = "";
  }
});

it("일반 인용문은 기존 모습 그대로(콜아웃 클래스 없음)", async () => {
  const view = await mount("> 그냥 인용문\n> 두 번째 줄\n");
  try {
    expect(document.body.innerHTML).not.toContain("md-callout-");
    expect(document.querySelector(".md-callout-icon")).toBeNull();
  } finally {
    view.destroy();
    document.body.innerHTML = "";
  }
});

it("접기 표식(+/-)도 마커로 삼키고 내용 없는 콜아웃도 성립한다", async () => {
  const view = await mount("> [!warning]-\n> 접힌 경고\n");
  try {
    const icon = document.querySelector(".md-callout-icon");
    expect(icon?.textContent).toBe("⚠️");
    expect(document.body.innerHTML).toContain("md-callout-warning");
  } finally {
    view.destroy();
    document.body.innerHTML = "";
  }
});
