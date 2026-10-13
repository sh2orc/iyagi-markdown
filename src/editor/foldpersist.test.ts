// 접기 상태의 탭 전환 유지 회귀 가드 — foldState는 EditorState 필드라
// activate()의 상태 라운드트립(prev.state 저장 → setState 복원)으로 이미
// 보존된다(별도 저장 메커니즘 불필요 — 이 불변식을 못 박는 테스트).

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { foldEffect, foldGutter, foldState, foldable } from "@codemirror/language";
import { fenceFoldOf, quoteFoldOf } from "./cm";

describe("접기 상태 탭 전환 유지", { retry: 1 }, () => {
  it("저장된 EditorState를 새 뷰에 싣으면 foldState가 따라온다", () => {
    const doc = "# A\n\n본문\n\n## B\n\n내용\n";
    const exts = [markdown({ base: markdownLanguage, extensions: [GFM], addKeymap: false }), foldGutter()];
    const host1 = document.createElement("div");
    document.body.append(host1);
    const v1 = new EditorView({ state: EditorState.create({ doc, extensions: exts }), parent: host1 });
    // 0행 제목 접기(foldable 결과를 foldEffect로).
    const range = foldable(v1.state, 0, 3);
    expect(range).not.toBeNull();
    v1.dispatch({ effects: foldEffect.of(range!) });
    const saved = v1.state;
    expect(saved.field(foldState, false)?.size).toBe(1);
    // 탭 복원 시뮬레이션 — 새 뷰에 저장 상태.
    const host2 = document.createElement("div");
    document.body.append(host2);
    const v2 = new EditorView({ state: saved, parent: host2 });
    expect(v2.state.field(foldState, false)?.size).toBe(1);
    v1.destroy();
    v2.destroy();
  });
});

describe("fenceFoldOf — 코드펜스 접기", () => {
  const stateOf = (doc: string) => EditorState.create({ doc });
  const DOC = "앞\n```rust\nfn a() {}\nfn b() {}\n```\n뒤\n";

  it("여는 펜스 줄에서 닫는 줄 전까지", () => {
    const st = stateOf(DOC);
    const r = fenceFoldOf(st, st.doc.line(2).from);
    expect(r).toEqual({ from: st.doc.line(2).to, to: st.doc.line(4).to });
  });

  it("~~~ 펜스도·펜스 밖은 null", () => {
    const st = stateOf("~~~\ncode\n~~~\n");
    expect(fenceFoldOf(st, st.doc.line(1).from)).toEqual({ from: st.doc.line(1).to, to: st.doc.line(2).to });
    expect(fenceFoldOf(st, st.doc.line(4).from)).toBeNull();
  });

  it("닫는 줄 없으면 null(미완성 펜스)", () => {
    const st = stateOf("```\ncode\n");
    expect(fenceFoldOf(st, st.doc.line(1).from)).toBeNull();
  });
});

describe("quoteFoldOf — 인용 접기", () => {
  const stateOf = (doc: string) => EditorState.create({ doc });

  it("첫 > 줄에서 인용 끝까지", () => {
    const st = stateOf("> a\n> b\n본문\n");
    expect(quoteFoldOf(st, st.doc.line(1).from)).toEqual({ from: st.doc.line(1).to, to: st.doc.line(2).to });
  });

  it("한 줄 인용·인용 아님은 null", () => {
    const st = stateOf("> only\n");
    expect(quoteFoldOf(st, st.doc.line(1).from)).toBeNull();
    expect(quoteFoldOf(st, st.doc.line(1).to)).toBeNull(); // 줄 시작 아님
  });
});
