// 라이브 프리뷰 렌더링 회귀 — 실제 샘플 문서(docs/sample.md)로 전체 확인.
// 두 가지 실제 버그의 방어:
//  1) 파서가 조각으로 완료되면 syntaxTreeAvailable(isDone)이 영원히 false →
//     장식이 아예 붙지 않음(커버리지 게이트로 해결).
//  2) 플러그인 update 안의 동기 dispatch → "update is in progress" 크래시로
//     장식 적용이 중간에 끊김(마이크로태스크 지연으로 해결).
// 뷰포트 아래 내용은 CM이 DOM을 만들지 않으므로(가상화) 위젯은 장식 필드로 검증.
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";

import { createDocState } from "./cm";
import { __testing, setPreviewConfig } from "./livePreview";

const SAMPLE = readFileSync(process.cwd() + "/docs/sample.md", "utf8");

function widgetKinds(view: EditorView): Record<string, number> {
  const decos = __testing.buildDecorations(view);
  const kinds: Record<string, number> = {};
  const cursor = decos.iter();
  while (cursor.value) {
    const spec = (cursor.value as unknown as {
      spec: { class?: string; widget?: { constructor: { name: string } } };
    }).spec;
    const key = spec.widget ? `widget:${spec.widget.constructor.name}` : (spec.class ?? "line");
    kinds[key] = (kinds[key] ?? 0) + 1;
    cursor.next();
  }
  return kinds;
}

async function makeView(mode: "read" | "edit"): Promise<EditorView> {
  const view = new EditorView({ state: createDocState(SAMPLE, mode), parent: document.body });
  view.dispatch({
    effects: setPreviewConfig.of({
      baseDir: "/tmp",
      remoteImages: true,
      showImages: true,
      theme: "light",
    }),
  });
  await new Promise((r) => setTimeout(r, 120));
  return view;
}

describe("샘플 문서 라이브 프리뷰", () => {
  it("읽기 모드 — 문서 전체의 모든 요소가 장식된다", async () => {
    const view = await makeView("read");
    const kinds = widgetKinds(view);
    const field = view.state.field(__testing.decorationField, false);
    expect((field as unknown as { size: number }).size).toBeGreaterThan(40);
    // 블록·인라인 구분 없이 위젯이 만들져야 한다(표·과제·수평선·수식·다이어그램·이미지).
    expect(kinds["widget:TableWidget"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(kinds["widget:TaskItemWidget"] ?? 0).toBeGreaterThanOrEqual(2);
    expect(kinds["widget:HRuleWidget"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(kinds["widget:MathWidget"] ?? 0).toBeGreaterThanOrEqual(3);
    expect(kinds["widget:DiagramWidget"] ?? 0).toBeGreaterThanOrEqual(2);
    expect(kinds["widget:ImageWidget"] ?? 0).toBeGreaterThanOrEqual(1);
    // 뷰포트 안 요소는 실제 DOM에도 나타난다(표는 문서 앞쪽).
    expect(document.querySelector(".md-table")).not.toBeNull();
    expect(document.querySelector(".md-task")).not.toBeNull();
    view.destroy();
    document.body.innerHTML = "";
  });

  it("편집 모드 — 커서(문서 시작) 줄만 원문, 나머지는 렌더", async () => {
    const view = await makeView("edit");
    const kinds = widgetKinds(view);
    expect(kinds["widget:TableWidget"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(kinds["widget:MathWidget"] ?? 0).toBeGreaterThanOrEqual(3);
    // 커서가 첫 줄(H1)에 있으므로 h1 줄 클래스는 있지만 # 심볼은 숨겨지지 않는다.
    expect(document.body.textContent).toContain("# IYAGI Markdown"); // 커서 줄 원문 노출 확인
    view.destroy();
    document.body.innerHTML = "";
  });

  it("플러그인 갱신 중 크래시 없이 장식이 적용된다(update-dispatch 회귀)", async () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
    const view = await makeView("read");
    // 문서 편집 + 선택 변경 + 설정 변경을 몰아치면 과거의 동기 dispatch 크래시가 났다.
    for (let i = 0; i < 5; i++) {
      view.dispatch({ changes: { from: 0, insert: "x" } });
      view.dispatch({ selection: { anchor: i + 1 } });
      view.dispatch({
        effects: setPreviewConfig.of({
          baseDir: "/x",
          remoteImages: false,
          showImages: true,
          theme: "dark",
        }),
      });
    }
    await new Promise((r) => setTimeout(r, 120));
    console.error = orig;
    expect(errors.filter((e) => e.includes("not allowed") || e.includes("crashed"))).toEqual([]);
    const field = view.state.field(__testing.decorationField, false);
    expect((field as unknown as { size: number }).size).toBeGreaterThan(0);
    view.destroy();
    document.body.innerHTML = "";
  });
});
