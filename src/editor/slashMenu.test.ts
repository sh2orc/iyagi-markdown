// / 메뉴(Notion식 블록 삽입) — 트리거 조건·검색·적용.

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { autocompletion, CompletionContext, currentCompletions } from "@codemirror/autocomplete";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { EditorState, StateEffect } from "@codemirror/state";
import { undo } from "@codemirror/commands";

import { createDocState } from "./cm";
import { SLASH_ITEMS, slashCompletions } from "./slashMenu";
import { combinedMatcher } from "./wikiComplete";

function resultAt(doc: string, pos?: number) {
  const view = new EditorView({ state: createDocState(doc, "edit"), parent: document.body });
  const p = pos ?? view.state.doc.length;
  ensureSyntaxTree(view.state, view.state.doc.length, 1000);
  const r = slashCompletions(new CompletionContext(view.state, p, false, view));
  return { r, view };
}

describe("/ 메뉴 — 트리거", () => {
  it("줄 처음 '/' → 전체 항목, 교체 범위는 슬래시부터", () => {
    const { r, view } = resultAt("/");
    expect(r).not.toBeNull();
    expect(r!.from).toBe(0);
    expect(r!.options.length).toBe(SLASH_ITEMS.length);
    view.destroy();
  });

  it("공백 뒤 '/'도 트리거", () => {
    const { r, view } = resultAt("본문 /");
    expect(r).not.toBeNull();
    expect(r!.from).toBe(3);
    view.destroy();
  });

  it("단어 가운데 슬래시는 열지 않는다(URL·한글 붙여쓰기)", () => {
    for (const doc of ["https://example", "남자/여자", "a/b"]) {
      const { r, view } = resultAt(doc);
      expect(r).toBeNull();
      view.destroy();
    }
  });

  it("코드펜스·프론트매터 안에서는 열지 않는다", () => {
    const fenced = resultAt("```\ncode/\n```");
    expect(fenced.r).toBeNull();
    fenced.view.destroy();
    const fm = resultAt("---\ntitle: a/\n---\n\n본문");
    expect(fm.r).toBeNull();
    fm.view.destroy();
  });

  it("combinedMatcher 체인에 끼워져 있다", () => {
    const view = new EditorView({ state: createDocState("/", "edit"), parent: document.body });
    const r = combinedMatcher(new CompletionContext(view.state, 1, false, view));
    expect(r).not.toBeNull();
    expect(r!.from).toBe(0);
    view.destroy();
  });

  it.each([
    "```\n/h1\n```", "    /h1", "`/h1`", "---\ntitle: /h1\n---", "$x /h1$",
    "$$\n/h1\n$$", "<div>\n/h1\n</div>", "[label /h1](target)", "![alt /h1](image.png)",
    "[[page /h1]]",
  ])("보호 구문의 실제 커서 위치에서는 열지 않는다: %s", (source) => {
    const { r, view } = resultAt(source, source.indexOf("/h1") + 3);
    try { expect(r).toBeNull(); } finally { view.destroy(); }
  });
});

describe("/ 메뉴 — 검색", () => {
  it("한글 질의 '/제목' → 제목 1·2·3", () => {
    const { r, view } = resultAt("/제목");
    expect(r!.options.map((o) => o.label)).toEqual(["제목 1", "제목 2", "제목 3"]);
    view.destroy();
  });

  it("영어 질의 '/table' → 표·목차(en 별칭), '/h1' → 제목 1(id 검색)", () => {
    const t = resultAt("/table");
    expect(t.r!.options.map((o) => o.label)).toEqual(["표", "목차"]); // table of contents 포함
    t.view.destroy();
    const h = resultAt("/h1");
    expect(h.r!.options.map((o) => o.label)).toEqual(["제목 1"]);
    h.view.destroy();
  });

  it("매칭 없는 질의 → 메뉴 없음", () => {
    const { r, view } = resultAt("/zzz");
    expect(r).toBeNull();
    view.destroy();
  });

  it("실제 자동완성에서도 영문 별칭 결과가 남고 지우면 전체 항목이 돌아온다", async () => {
    vi.useFakeTimers();
    const view = new EditorView({ parent: document.body, state: EditorState.create({
      doc: "", extensions: [autocompletion({ override: [slashCompletions] })],
    }) });
    try {
      view.dispatch({ changes: { from: 0, insert: "/table" }, selection: { anchor: 6 }, userEvent: "input.type" });
      await vi.advanceTimersByTimeAsync(200);
      expect(currentCompletions(view.state).map((item) => item.label)).toEqual(["표", "목차"]);
      view.dispatch({ changes: { from: 1, to: 6 }, userEvent: "delete.backward" });
      await vi.advanceTimersByTimeAsync(100);
      expect(currentCompletions(view.state).map((item) => item.label)).toContain("코드 블록");
      view.dispatch({ changes: { from: 0, to: 1 }, userEvent: "delete.backward" });
      await vi.advanceTimersByTimeAsync(100);
      expect(currentCompletions(view.state)).toHaveLength(0);
    } finally { view.destroy(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
});

describe("/ 메뉴 — 적용", () => {
  it("'/h1' → 줄머리 '# ' 변형, 커서는 접두 뒤", () => {
    const view = new EditorView({ state: createDocState("/h1", "edit"), parent: document.body });
    const item = SLASH_ITEMS.find((i) => i.id === "h1")!;
    item.apply(view, 0, 3);
    expect(view.state.doc.toString()).toBe("# ");
    expect(view.state.selection.main.head).toBe(2);
    view.destroy();
  });

  it("기존 본문 줄의 '/quote' → 접두를 앞에 붙이고 질의는 제거", () => {
    const view = new EditorView({ state: createDocState("본문입니다 /quote", "edit"), parent: document.body });
    const item = SLASH_ITEMS.find((i) => i.id === "quote")!;
    item.apply(view, 6, 12); // "/quote" 구간
    expect(view.state.doc.toString()).toBe("> 본문입니다 ");
    view.destroy();
  });

  it("코드 블록 — 커서가 펜스 안에", () => {
    const view = new EditorView({ state: createDocState("/code", "edit"), parent: document.body });
    const item = SLASH_ITEMS.find((i) => i.id === "code")!;
    item.apply(view, 0, 5);
    expect(view.state.doc.toString()).toBe("```\n\n```");
    expect(view.state.selection.main.head).toBe(4);
    view.destroy();
  });

  it("표 — 질의와 템플릿을 한 번에 교체하고 실행 취소한다", () => {
    const view = new EditorView({ state: createDocState("/표", "edit"), parent: document.body });
    const item = SLASH_ITEMS.find((i) => i.id === "table")!;
    item.apply(view, 0, 2);
    expect(view.state.doc.toString()).toContain("| --- |");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("/표");
    view.destroy();
  });

  it("표 삽입이 거절되어도 슬래시 질의만 사라지지 않는다", () => {
    const view = new EditorView({ state: createDocState("/표", "edit"), parent: document.body });
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
    try {
      SLASH_ITEMS.find((item) => item.id === "table")!.apply(view, 0, 2);
      expect(view.state.doc.toString()).toBe("/표");
    } finally { view.destroy(); }
  });

  it.each(["pagebreak", "toc"])("%s는 에디터 커서와 무관하게 명령 범위를 한 번에 교체한다", (id) => {
    const source = `# Heading\n\n/${id}\n\nTail`, from = source.indexOf("/"), to = from + id.length + 1;
    const view = new EditorView({ state: createDocState(source, "edit"), parent: document.body });
    let changed = 0;
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of((u) => { if (u.docChanged) changed++; })) });
    try {
      SLASH_ITEMS.find((item) => item.id === id)!.apply(view, from, to);
      expect(changed).toBe(1);
      expect(view.state.doc.toString()).toContain(id === "toc" ? "- [Heading](#heading)" : "\\newpage");
      expect(view.state.doc.toString()).toMatch(/^# Heading\n\n/);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(source);
    } finally { view.destroy(); }
  });

  it("제목이 없으면 목차 명령과 커서를 그대로 보존한다", () => {
    const view = new EditorView({ state: createDocState("/toc", "edit"), parent: document.body });
    const before = view.state;
    try {
      SLASH_ITEMS.find((item) => item.id === "toc")!.apply(view, 0, 4);
      expect(view.state.doc.eq(before.doc)).toBe(true);
      expect(view.state.selection.eq(before.selection)).toBe(true);
    } finally { view.destroy(); }
  });

  it.each(SLASH_ITEMS.map((item) => item.id))("%s는 읽기 전용·필터 거절 시 명령어를 지우지 않는다", (id) => {
    for (const readonly of [true, false]) {
      const source = `# Heading\n\n/${id}`, from = source.indexOf("/");
      const view = new EditorView({ parent: document.body, state: createDocState(source, readonly ? "read" : "edit") });
      if (!readonly) view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of((tr) => tr.docChanged ? [] : tr)) });
      try {
        SLASH_ITEMS.find((item) => item.id === id)!.apply(view, from, source.length);
        expect(view.state.doc.toString()).toBe(source);
      } finally { view.destroy(); }
    }
  });

  it("완성 결과를 만든 뒤 슬래시 문맥이 사라졌으면 오래된 결과를 적용하지 않는다", () => {
    const { r, view } = resultAt("/h1");
    const option = r!.options[0];
    view.dispatch({ changes: { from: 0, to: 1, insert: "x" } });
    try {
      if (typeof option.apply !== "function") throw new Error("Expected slash apply callback");
      option.apply(view, option, 0, 3);
      expect(view.state.doc.toString()).toBe("xh1");
    } finally { view.destroy(); }
  });
});
