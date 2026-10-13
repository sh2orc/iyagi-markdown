// 불릿 글리프 렌더링 확인(20차) — 문서 사용자 보고 "불렛이 제대로 표현 안 됨".
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { createDocState } from "./editor/cm";
import { __testing, setPreviewConfig } from "./editor/livePreview";

describe("불릿 글리프", () => {
  it("깊이별 • ◦ ▪ 로 표시되고 커서 닿으면 원문", async () => {
    const doc = "- 하나\n- 둘\n  - 중첩\n    - 더 깊이\n";
    const view = new EditorView({ state: createDocState(doc, "edit"), parent: document.body });
    // 커서를 문서 끝으로 — 기본 커서(0)가 첫 마커를 원문으로 만들지 않게.
    view.dispatch({ selection: { anchor: doc.length } });
    view.dispatch({
      effects: setPreviewConfig.of({ baseDir: "/tmp", remoteImages: true, showImages: true, theme: "light", imageWidths: {}, bookmarks: [], tableWidths: {}, wikiIndex: new Map() }),
    });
    await new Promise((r) => setTimeout(r, 150));
    const field = view.state.field(__testing.decorationField, false);
    const c = field!.iter();
    let bullets = 0;
    while (c.value) {
      const spec = (c.value as unknown as { spec: { widget?: { constructor: { name: string }; glyph?: string } } }).spec;
      if (spec.widget?.constructor.name === "BulletWidget") bullets += 1;
      c.next();
    }
    expect(bullets).toBe(4); // 최상위 2 + 중첩 1 + 더 깊이 1
    // 첫 마커를 선택이 완전히 감싸면 원문 노출 → 불릿 3개(102차 규칙 —
    // 커서 접촉만으로는 마커가 드러나지 않는다).
    view.dispatch({ selection: { anchor: 0, head: 2 } });
    await new Promise((r) => setTimeout(r, 100));
    const c2 = view.state.field(__testing.decorationField, false)!.iter();
    let bullets2 = 0;
    while (c2.value) {
      const spec = (c2.value as unknown as { spec: { widget?: { constructor: { name: string } } } }).spec;
      if (spec.widget?.constructor.name === "BulletWidget") bullets2 += 1;
      c2.next();
    }
    expect(bullets2).toBe(3);
    view.destroy();
    document.body.innerHTML = "";
  });
});
