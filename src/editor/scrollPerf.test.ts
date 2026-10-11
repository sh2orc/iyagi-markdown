// 스크롤·선택 성능 회귀 — 장식 재계산이 청크 단위로 일어나는지 검증한다.
//
//  1) 완전 파싱 후 커서 이동이 장식을 갱신해야 한다(과거 구현의 트리 성장
//     게이트(treeLen 비교)는 파싱이 끝난 문서에서 디스패치를 영원히 막아
//     커서 줄 원문 노출이 멈추던 회귀).
//  2) 커서 이동은 전체 재계산이 아니라 관련 청크만 다시 계산한다(스크롤
//     프레임 보호 — 전체 재빌드는 뚝뚝 끊기는 스크롤의 원인).
//  3) 청크 경계는 블록 규칙을 지킨다(코드펜스·표 등 원자 블록은 쪼개지
//     않고, 긴 목록은 쪼갠다).
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";

import { createDocState } from "./cm";
import { TableWidget } from "./widgets";
import { __testing, setPreviewConfig } from "./livePreview";

const SAMPLE = readFileSync(process.cwd() + "/docs/sample.md", "utf8");

async function untilParsed(view: EditorView, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (syntaxTree(view.state).length < view.state.doc.length && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(syntaxTree(view.state).length).toBe(view.state.doc.length);
}

async function makeView(mode: "read" | "edit", doc = SAMPLE): Promise<EditorView> {
  const view = new EditorView({ state: createDocState(doc, mode), parent: document.body });
  view.dispatch({
    effects: setPreviewConfig.of({
      baseDir: "/tmp",
      remoteImages: true,
      showImages: true,
      theme: "light",
    }),
  });
  await untilParsed(view);
  await new Promise((r) => setTimeout(r, 60));
  return view;
}

function tableRanges(view: EditorView): { from: number; to: number }[] {
  const decos = view.state.field(__testing.decorationField, false);
  const out: { from: number; to: number }[] = [];
  if (!decos) return out;
  const cursor = decos.iter();
  while (cursor.value) {
    const spec = (cursor.value as unknown as { spec: { widget?: unknown } }).spec;
    if (spec.widget instanceof TableWidget) out.push({ from: cursor.from, to: cursor.to });
    cursor.next();
  }
  return out;
}

describe("라이브 프리뷰 증분 갱신", () => {
  it("완전 파싱 후 커서가 표로 이동하면 해당 표가 원문으로 풀린다", async () => {
    const view = await makeView("edit");
    const tables = tableRanges(view);
    expect(tables.length).toBeGreaterThanOrEqual(1);
    const t = tables[0];
    const pos = t.from + 2;
    view.dispatch({ selection: { anchor: pos } });
    await new Promise((r) => setTimeout(r, 80));
    const covering = tableRanges(view).filter((r) => r.from <= pos && r.to > pos);
    expect(covering).toEqual([]);
    view.destroy();
    document.body.innerHTML = "";
  });

  it("커서 이동은 관련 청크만 다시 계산한다(전체 재빌드 아님)", async () => {
    // sample.md(2KB)는 청크 하나라 증분이 드러나지 않는다 — 큰 문서를 만든다.
    const parts: string[] = ["# Big\n"];
    for (let i = 0; i < 300; i++) parts.push(`문단 ${i} — ${"가".repeat(80)} 문장입니다.\n`);
    parts.push("\n## 중간 제목\n");
    for (let i = 0; i < 300; i++) parts.push(`또 문단 ${i} — ${"나".repeat(80)} 문장입니다.\n`);
    parts.push("\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    const doc = parts.join("\n");
    const view = await makeView("edit", doc);
    const headingPos = doc.indexOf("## 중간 제목");
    expect(headingPos).toBeGreaterThan(0);
    __testing.resetStats();
    view.dispatch({ selection: { anchor: headingPos + 3 } });
    await new Promise((r) => setTimeout(r, 80));
    expect(__testing.stats.chunkBuilds).toBeGreaterThanOrEqual(1);
    expect(__testing.stats.chunkBuilds).toBeLessThanOrEqual(4);
    expect(__testing.stats.chars).toBeLessThan(doc.length * 0.6);
    view.destroy();
    document.body.innerHTML = "";
  });

  it("변경 없는 갱신(포커스)은 재계산을 유발하지 않는다", async () => {
    const view = await makeView("read");
    __testing.resetStats();
    view.focus();
    view.contentDOM.blur();
    await new Promise((r) => setTimeout(r, 80));
    expect(__testing.stats.chunkBuilds).toBe(0);
    expect(__testing.stats.dispatches).toBe(0);
    view.destroy();
    document.body.innerHTML = "";
  });

  it("청크 경계 — 코드펜스는 쪼개지 않고 긴 목록은 쪼갠다", async () => {
    const fence = "```js\n" + "x".repeat(40_000) + "\n```\n";
    const items = Array.from({ length: 300 }, (_, i) => `- ${"i".repeat(150)} ${i}`).join("\n");
    const doc = "# T\n\npara\n\n" + fence + "\n" + items + "\n";
    const view = await makeView("read", doc);
    const { ends } = __testing.computeBoundaries(view);
    expect(ends.length).toBeGreaterThanOrEqual(2);
    // 오름차순 정렬.
    for (let i = 1; i < ends.length; i++) expect(ends[i]).toBeGreaterThan(ends[i - 1]);
    // 코드펜스 내부에는 경계가 없다(원자 블록).
    const fenceFrom = doc.indexOf("```js");
    const fenceTo = doc.indexOf("```", fenceFrom + 5) + 3;
    for (const e of ends) expect(e <= fenceFrom || e >= fenceTo).toBe(true);
    // 긴 목록 내부에는 경계가 있다(분할 — 재빌드 범위 상한).
    const listFrom = doc.indexOf("- iiii");
    expect(ends.some((e) => e > listFrom && e < doc.length - 2)).toBe(true);
    view.destroy();
    document.body.innerHTML = "";
  });

  it("큰 문서 초기 렌더 — 파싱 진행 중에도 각 청크는 한 번만 계산된다", async () => {
    const parts: string[] = [];
    for (let i = 0; i < 2000; i++) {
      parts.push(`## 제목 ${i}\n\n${"내용".repeat(30)} 문단입니다.\n`);
    }
    const doc = parts.join("\n");
    __testing.resetStats();
    const view = new EditorView({ state: createDocState(doc, "read"), parent: document.body });
    view.dispatch({
      effects: setPreviewConfig.of({
        baseDir: "/tmp",
        remoteImages: true,
        showImages: true,
        theme: "light",
      }),
    });
    // 전체 파싱 완료를 기다리지 않는다(jsdom에선 느리다) — 진행 중인 상태로
    // "한 청크 한 번" 규칙을 검증한다.
    await new Promise((r) => setTimeout(r, 1500));
    const covered = syntaxTree(view.state).length;
    expect(covered).toBeGreaterThan(30_000);
    const chunks = __testing.stats.chunkBuilds;
    expect(chunks).toBeGreaterThanOrEqual(3);
    // 파싱이 덮은 범위는 전부 장식했지만, 각 청크는 한 번만(과거 구현은
    // 파싱 한 조각마다 스캔 창 전체를 재계산했다).
    expect(__testing.stats.chars).toBeLessThan(covered * 1.6);
    expect(__testing.stats.dispatches).toBeLessThanOrEqual(chunks + 2);
    const field = view.state.field(__testing.decorationField, false);
    expect((field as unknown as { size: number }).size).toBeGreaterThan(100);
    view.destroy();
    document.body.innerHTML = "";
  });
});
