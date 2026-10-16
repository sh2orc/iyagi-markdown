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

import { createDocState, switchMode } from "./cm";
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
      imageWidths: {},
      bookmarks: [],
      tableWidths: {},
      wikiIndex: new Map(),
    }),
  });
  await new Promise((r) => setTimeout(r, 120));
  return view;
}

describe("샘플 문서 라이브 프리뷰", { retry: 2 }, () => {
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

  it("편집 모드 — 커서가 제목에 닿아도 #는 숨김, 선택이 덮으면 노출", async () => {
    const view = await makeView("edit");
    const kinds = widgetKinds(view);
    expect(kinds["widget:TableWidget"] ?? 0).toBeGreaterThanOrEqual(1);
    expect(kinds["widget:MathWidget"] ?? 0).toBeGreaterThanOrEqual(3);
    // 커서가 첫 줄(H1)에 있어도 # 마커는 숨겨진다(클릭=텍스트 편집, 마커 아님).
    expect(document.body.textContent).not.toContain("# IYAGI Markdown");
    // 줄 처음부터 쓸어 담으면(마커를 완전히 감싸면) 원문 노출.
    const line1 = view.state.doc.line(1);
    view.dispatch({ selection: { anchor: line1.from, head: Math.min(line1.to, line1.from + 4) } });
    await new Promise((r) => setTimeout(r, 60));
    expect(document.body.textContent).toContain("# IYAGI Markdown");
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
          imageWidths: {},
          bookmarks: [],
          tableWidths: {},
          wikiIndex: new Map(),
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

// 실제 적용된 장식(상태 필드) 기준 — buildDecorations는 빌드 파이프라인 직접
// 실행이라 소스 모드 게이트를 우회한다.
function appliedKinds(view: EditorView): Record<string, number> {
  const decos = view.state.field(__testing.decorationField);
  const kinds: Record<string, number> = {};
  const cursor = decos.iter();
  while (cursor.value) {
    kinds.dec = (kinds.dec ?? 0) + 1;
    cursor.next();
  }
  return kinds;
}

describe("소스 모드 — 라이브 프리뷰 장식 없음(원문 그대로)", { retry: 1 }, () => {
  it("source: 위젯·클래스 장식 0", async () => {
    const view = new EditorView({ state: createDocState(SAMPLE, "source"), parent: document.body });
    await new Promise((r) => setTimeout(r, 40));
    expect(Object.keys(appliedKinds(view)).length).toBe(0);
    view.destroy();
  });

  it("edit → source 전환: 기존 장식 해제, 복귀 시 재생성", async () => {
    const view = new EditorView({ state: createDocState(SAMPLE, "edit"), parent: document.body });
    await new Promise((r) => setTimeout(r, 40));
    expect(Object.keys(widgetKinds(view)).length).toBeGreaterThan(0);
    switchMode(view, "source");
    await new Promise((r) => setTimeout(r, 40));
    expect(Object.keys(appliedKinds(view)).length).toBe(0);
    switchMode(view, "edit");
    await new Promise((r) => setTimeout(r, 60));
    expect(Object.keys(appliedKinds(view)).length).toBeGreaterThan(0);
    view.destroy();
  });
});
