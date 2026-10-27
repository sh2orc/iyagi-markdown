// 회귀 — 문서 첫 줄 --- 이 수평선으로 보여야 한다(2026-10-20 보고: 닫는
// --- 없는 --- 을 프론트매터 파서가 삼켜 구분선이 안 보였다). 파서 규칙
// 자체는 frontmatter.test.ts가 잠그고, 여기선 실제 편집기 스택(cm.ts
// 전체)으로 위젯 렌더링과 증분 전환(수평선↔프론트매터)까지 잠근다.
// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { EditorView, EditorView as EV } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";

import { createDocState, switchMode } from "./cm";
import { __testing, setPreviewConfig } from "./livePreview";

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

let view: EditorView | null = null;

async function mount(doc: string, cursorPos: number): Promise<EditorView> {
  view = new EditorView({ state: createDocState(doc, "edit"), parent: document.body });
  if (cursorPos >= 0) view.dispatch({ selection: { anchor: cursorPos } });
  view.dispatch({ effects: PREVIEW });
  ensureSyntaxTree(view.state, view.state.doc.length, 1000);
  await new Promise((r) => setTimeout(r, 120));
  return view;
}

/** 최상위 노드 `이름[from,to]` 목록. */
function topNames(v: EditorView): string[] {
  const out: string[] = [];
  let cur = syntaxTree(v.state).topNode.firstChild;
  while (cur) {
    out.push(`${cur.name}[${cur.from},${cur.to}]`);
    cur = cur.nextSibling;
  }
  return out;
}

/** 렌더된 수평선 위젯 수(장식 트리에서 HRuleWidget 직접 센다). */
function hrWidgetCount(v: EditorView): number {
  const decos = __testing.buildDecorations(v);
  let n = 0;
  const cursor = decos.iter();
  while (cursor.value) {
    const spec = (cursor.value as unknown as {
      spec: { widget?: { constructor: { name: string } } };
    }).spec;
    if (spec.widget?.constructor.name === "HRuleWidget") n++;
    cursor.next();
  }
  return n;
}

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.innerHTML = "";
});

describe("문서 첫 줄 --- 수평선(위젯)", () => {
  it("닫는 --- 없는 첫 줄 — 수평선 위젯 렌더(커서는 본문)", async () => {
    const v = await mount("---\n본문\n", 5);
    expect(topNames(v)[0]).toBe("HorizontalRule[0,3]");
    expect(hrWidgetCount(v)).toBe(1);
  });

  it("단독 --- (커서 다음 줄) — 위젯", async () => {
    const v = await mount("---\n", 4);
    expect(hrWidgetCount(v)).toBe(1);
  });

  it("닫는 --- 있는 프론트매터 — 수평선 위젯 없음(칩 그대로)", async () => {
    const v = await mount("---\ntitle: x\n---\n본문\n", 0);
    expect(topNames(v)[0]).toMatch(/^FrontMatter\[/);
    expect(hrWidgetCount(v)).toBe(0);
  });
});

describe("수평선↔프론트매터 증분 전환", () => {
  it("닫는 --- 을 나중에 타이핑해도 FrontMatter로 전환(조각 재사용 방어)", async () => {
    const v = await mount("---\ntitle: x\n", 12);
    expect(topNames(v)[0]).toMatch(/^HorizontalRule\[/);
    v.dispatch({ changes: { from: v.state.doc.length, insert: "---\n본문\n" } });
    ensureSyntaxTree(v.state, v.state.doc.length, 1000);
    await new Promise((r) => setTimeout(r, 50));
    const names = topNames(v);
    expect(names[0]).toMatch(/^FrontMatter\[/);
    expect(names[1]).toMatch(/^Paragraph\[/);
  });

  it("본문 중간 --- (빈 줄 뒤) — 여전히 수평선", async () => {
    const v = await mount("위\n\n---\n아래\n", 8);
    expect(topNames(v)[1]).toMatch(/^HorizontalRule\[/);
    expect(hrWidgetCount(v)).toBe(1);
  });
});

/** 실제 DOM(.md-hr)으로 보는 타이핑 흐름 — buildDecorations 즉석 계산이
 *  아니라 뷰에 붙은 장식. splitSetextUnderline(cm.ts) 회귀. */
function typeChars(v: EditorView, text: string) {
  for (const ch of text) {
    const pos = v.state.selection.main.head;
    v.dispatch({
      changes: { from: pos, insert: ch },
      selection: { anchor: pos + 1 },
      userEvent: "input.type",
    });
  }
}

function pressEnter(v: EditorView) {
  const pos = v.state.selection.main.head;
  v.dispatch({
    changes: { from: pos, insert: "\n" },
    selection: { anchor: pos + 1 },
    userEvent: "input.type",
  });
}

describe("문단 바로 아래 --- 타이핑 — 셋텍스트 자동 분리(실제 DOM)", () => {
  it("문단 아래 --- → 빈 줄 자동 삽입 → Enter로 수평선(2026-10-20 보고 주 원인)", async () => {
    const v = await mount("위\n", 2);
    typeChars(v, "---");
    await new Promise((r) => setTimeout(r, 150));
    // 셋텍스트 H2가 되는 대신 빈 줄이 올라간다 — 문단은 제목으로 변하지 않는다.
    expect(v.state.doc.toString()).toBe("위\n\n---");
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
    pressEnter(v);
    await new Promise((r) => setTimeout(r, 150));
    expect(v.dom.querySelectorAll(".md-hr").length).toBe(1);
  });

  it("빈 줄 아래 --- 는 그대로 — 빈 줄 이중 삽입 없음", async () => {
    const v = await mount("위\n\n", 3);
    typeChars(v, "---");
    pressEnter(v);
    await new Promise((r) => setTimeout(r, 150));
    expect(v.state.doc.toString()).toBe("위\n\n---\n");
    expect(v.dom.querySelectorAll(".md-hr").length).toBe(1);
  });

  it("4번째 대시 — 재분리 없음(이미 빈 줄)", async () => {
    const v = await mount("위\n", 2);
    typeChars(v, "----");
    await new Promise((r) => setTimeout(r, 150));
    expect(v.state.doc.toString()).toBe("위\n\n----");
  });

  it("코드 블록 내부 --- 은 무변화", async () => {
    const v = await mount("```\nx\n\n", 7);
    typeChars(v, "---");
    await new Promise((r) => setTimeout(r, 150));
    expect(v.state.doc.toString()).toBe("```\nx\n\n---");
  });
});

/** 실제 키보드 입력과 같은 경로 — CM이 beforeinput에서 호출하는
 *  inputHandler 패싯을 직접 호출한다. dispatch로 트랜잭션을 넣으면
 *  우회해버려 smartPunct 대시 변환(--→–)을 못 본다(2026-10-21 — 이
 *  경로에서만 --- 이 – 로 바뀌어 구분선이 안 만들어졌다). */
function realType(v: EditorView, text: string) {
  const handlers = v.state.facet(EV.inputHandler);
  for (const ch of text) {
    const pos = v.state.selection.main.head;
    let handled = false;
    for (const h of handlers) {
      // 5번째 인자(insert)는 기본 삽입 트랜잭션 공급자 — 6.43 시그니처.
      if (
        h(v, pos, pos, ch, () =>
          v.state.update({
            changes: { from: pos, to: pos, insert: ch },
            selection: { anchor: pos + 1 },
            userEvent: "input.type",
          }),
        )
      ) {
        handled = true;
        break;
      }
    }
    if (!handled) {
      v.dispatch({
        changes: { from: pos, insert: ch },
        selection: { anchor: pos + 1 },
        userEvent: "input.type",
      });
    }
  }
}

describe("--- 타이핑 전체 파이프라인(실제 입력 경로)", () => {
  it("문단 아래 --- 실제 입력 → 변환 없이 완성 → 자동 분리 → Enter로 구분선", async () => {
    const v = await mount("위\n", 2);
    realType(v, "---");
    await new Promise((r) => setTimeout(r, 150));
    // smartPunct가 세 번째 - 를 – 로 바꾸지 않고, 셋텍스트 분리까지 일어난다.
    expect(v.state.doc.toString()).toBe("위\n\n---");
    pressEnter(v);
    await new Promise((r) => setTimeout(r, 150));
    expect(v.dom.querySelectorAll(".md-hr").length).toBe(1);
  });

  it("문서 시작 --- 실제 입력 — 변환 없이 완성", async () => {
    const v = await mount("", 0);
    realType(v, "---");
    await new Promise((r) => setTimeout(r, 150));
    expect(v.state.doc.toString()).toBe("---");
  });

  it("문장 중간 대시 변환(–)은 그대로 유지", async () => {
    const v = await mount("단어 x", 4);
    realType(v, "---");
    await new Promise((r) => setTimeout(r, 150));
    expect(v.state.doc.toString()).toBe("단어 x–");
  });

  it("문단 아래 - 한 글자(목록 시작) — 제목 변형도·빈 줄 삽입도 없음(2026-10-21 보고)", async () => {
    const v = await mount("내용\n", 3);
    realType(v, "-");
    await new Promise((r) => setTimeout(r, 150));
    // setext 밑줄은 - 1개로도 성립하지만 짧은 밑줄 렌더링 억제(livePreview)가
    // 제목 변형을 막는다 — 문서는 그대로(빈 줄 없이 목록이 문단을 중단한다).
    expect(v.state.doc.toString()).toBe("내용\n-");
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
    realType(v, " 항목");
    await new Promise((r) => setTimeout(r, 150));
    expect(v.state.doc.toString()).toBe("내용\n- 항목");
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
  });

  it("문단 아래 -- 두 글자 — 빈 줄 삽입 없음(3개부터 구분선 분리)", async () => {
    const v = await mount("내용\n", 3);
    realType(v, "--");
    await new Promise((r) => setTimeout(r, 150));
    expect(v.state.doc.toString()).toBe("내용\n--");
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
  });

  it("기존 '텍스트\\n---' 짝 — 렌더는 문단+구분선, 편집하면 문서도 정규화(2026-10-21 보고·방침)", async () => {
    const v = await mount("기존\n---\n", 2);
    // 대시 셋텍스트는 렌더가 이미 제목이 아니다(H2는 ## 로만).
    expect(v.dom.querySelectorAll(".md-h2").length).toBe(0);
    expect(v.dom.querySelectorAll(".md-hr").length).toBe(1);
    realType(v, "추가");
    await new Promise((r) => setTimeout(r, 150));
    // 편집하면 문서 자체도 정규화 — 내보내기(comrak)까지 일관.
    expect(v.state.doc.toString()).toBe("기존추가\n\n---\n");
    expect(v.dom.querySelectorAll(".md-h2").length).toBe(0);
    expect(v.state.selection.main.head).toBe(4); // 커서가 --- 줄로 밀리지 않음
  });

  it("대시 셋텍스트는 제목이 아니다 — H2는 ## 로만(2026-10-21 방침)", async () => {
    const v = await mount("위\n---\n아래\n", 9);
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
    expect(v.dom.querySelectorAll(".md-hr").length).toBe(1);
    // 트리에는 SetextHeading2가 남는다(정규화 전) — 렌더만 문단+구분선.
    expect(topNames(v)[0]).toMatch(/^SetextHeading2\[/);
    // 태그 하이라이트(t.heading2)의 font-size도 우회하지 않는지 — 장식 억제를
    // 넘어 크게 보이던 두 번째 경로(2026-10-21 '아직도' 보고).
    expect(v.dom.querySelectorAll(".cm-content span[style*='font-size']").length).toBe(0);
  });

  it("= 입력(밑줄 H1) — 1-2개는 분리 없이 제목도 아님, 3개부터 분리(2026-10-24 완화)", async () => {
    const v = await mount("내용\n", 3);
    realType(v, "=");
    await new Promise((r) => setTimeout(r, 150));
    // 1-2개는 빈 줄을 넣지 않는다 — 렌더 억제가 제목 변형을 막는다.
    expect(v.state.doc.toString()).toBe("내용\n=");
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
    realType(v, "==");
    await new Promise((r) => setTimeout(r, 150));
    expect(v.state.doc.toString()).toBe("내용\n\n===");
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
  });

  it("소스 모드 — 제목 태그 클래스가 소스 스코프에서만 산다(2026-10-24)", async () => {
    const v = await mount("## 제목\n", 0);
    expect(v.dom.classList.contains("cm-source-mode")).toBe(false);
    switchMode(v, "source");
    await new Promise((r) => setTimeout(r, 50));
    expect(v.dom.classList.contains("cm-source-mode")).toBe(true);
    expect(v.dom.querySelectorAll(".md-tag-h2").length).toBeGreaterThan(0);
    switchMode(v, "edit");
    await new Promise((r) => setTimeout(r, 50));
    expect(v.dom.classList.contains("cm-source-mode")).toBe(false);
    // 편집 모드에선 태그 클래스가 남아도 스타일 스코프가 없다(inline style 부재).
    expect(v.dom.querySelectorAll(".cm-content span[style*='font-size']").length).toBe(0);
  });

  it("기존 '텍스트\\n===' 짝 — 렌더도·편집 후 문서도 제목 아님", async () => {
    const v = await mount("기존\n===\n", 2);
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
    expect(v.dom.querySelectorAll(".cm-content span[style*='font-size']").length).toBe(0);
    realType(v, "추가");
    await new Promise((r) => setTimeout(r, 150));
    expect(v.state.doc.toString()).toBe("기존추가\n\n===\n");
    expect(v.state.selection.main.head).toBe(4);
  });

  it("인용구 안 --- 타이핑 — 분리+제목 아님(2026-10-24 검토: 인용구 구멍)", async () => {
    const v = await mount("> 인용문\n> ", 8);
    realType(v, "---");
    await new Promise((r) => setTimeout(r, 150));
    // 분리 삽입은 줄 시작 — 인용문은 끝나고 밑줄은 인용구 밖 구분선이 된다.
    expect(v.state.doc.toString()).toBe("> 인용문\n\n> ---");
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
  });

  it("인용구 setext 기존 짝 — 렌더도 제목 아님(HeaderMark 판정)", async () => {
    const v = await mount("> 인용문\n> ---\n", 11);
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
    expect(v.dom.querySelectorAll(".cm-content span[style*='font-size']").length).toBe(0);
  });

  it("- - - (공백 섞인 수평선) 입력 — Enter로 구분선", async () => {
    const v = await mount("위\n", 2);
    realType(v, "- - -");
    await new Promise((r) => setTimeout(r, 150));
    expect(v.state.doc.toString()).toBe("위\n- - -");
    pressEnter(v);
    await new Promise((r) => setTimeout(r, 150));
    expect(v.dom.querySelectorAll(".md-hr").length).toBe(1);
    expect(v.dom.querySelectorAll(".md-h1,.md-h2,.md-h3").length).toBe(0);
  });
});
