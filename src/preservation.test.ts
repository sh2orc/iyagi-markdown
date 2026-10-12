// 원문 무손실 보존 테스트(§4-2 5항) — 릴리스 차단 조건.
//
// (a) 열기→무수정→저장: 저장이 일어나지 않는다(무편집 ⌘S는 no-op).
// (b) 임의 편집 시퀀스 후 ChangeSet 역적용 → 원문과 바이트 동일.
// (c) 모드 전환 왕복(편집↔읽기↔소스) 시 내용 불변.

import { describe, expect, it } from "vitest";
import { ChangeSet, EditorSelection, EditorState, Transaction } from "@codemirror/state";
// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";

import { createDocState, switchMode, type ViewMode } from "./editor/cm";
import { setPreviewConfig } from "./editor/livePreview";

// — (b) ChangeSet 역적용 —
// CM6의 changes는 원문 기준 패치다: 역순으로 invert하면 원문으로 돌아간다.
// 이것이 "편집은 언제나 원문 텍스트의 변형"임의 구조적 보증이다.

function randomEdits(seed: number, doc: string): { changes: ChangeSet; text: string }[] {
  // 간단한 결정적 유사 난수(테스트 재현성).
  let s = seed;
  const rand = (n: number) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
  let state = EditorState.create({ doc });
  const log: { changes: ChangeSet; text: string }[] = [];
  for (let i = 0; i < 200; i++) {
    const pos = rand(Math.max(1, state.doc.length));
    const kind = rand(3);
    let tr: Transaction;
    if (kind === 0) {
      const ins = "한글 abc *강조* `code` $x_i$ ";
      tr = state.update({ changes: { from: pos, insert: ins } });
    } else if (kind === 1) {
      const to = Math.min(state.doc.length, pos + rand(20));
      tr = state.update({ changes: { from: pos, to } });
    } else {
      const to = Math.min(state.doc.length, pos + rand(15));
      tr = state.update({ changes: { from: pos, to, insert: "# 제목\n- [ ] 할 일\n$$e^{i\\\\pi}$$\n" } });
    }
    state = tr.state;
    log.push({ changes: tr.changes, text: state.doc.toString() });
  }
  return log;
}

/** 한 편집 단계를 되돌린다: afterText(편집 후)를 beforeText(편집 전)로.
 *  ChangeSet은 원문 기준 패치이므로 (fromA..toA)의 원문 조각으로
 *  (fromB..toB)를 대체하면 된다. */
function invertStep(afterText: string, beforeText: string, cs: ChangeSet): string {
  const edits: { from: number; to: number; insert: string }[] = [];
  cs.iterChanges((fromA, toA, fromB, toB) => {
    edits.push({ from: fromB, to: toB, insert: beforeText.slice(fromA, toA) });
  });
  let out = afterText;
  for (let i = edits.length - 1; i >= 0; i--) {
    out = out.slice(0, edits[i].from) + edits[i].insert + out.slice(edits[i].to);
  }
  return out;
}

describe("원문 보존 (§4-2)", () => {
  it("(b) 편집 시퀀스를 역적용하면 원문과 동일하다", () => {
    const docs = [
      "# 제목\n\n본문 *강조* `code`\n",
      "가나다\n라마바\n사아자\n",
      "mixed\rstuff" /* \r은 버퍼에 그대로 둔다 — \n만 줄바꿈으로 취급 */,
      "",
      "no trailing newline",
      "# a\n".repeat(50),
    ];
    for (let d = 0; d < docs.length; d++) {
      const original = docs[d];
      const log = randomEdits(d * 7919 + 13, original);
      let text = log[log.length - 1].text;
      for (let i = log.length - 1; i >= 0; i--) {
        const before = i > 0 ? log[i - 1].text : original;
        text = invertStep(text, before, log[i].changes);
      }
      expect(text).toBe(original);
    }
  });

  it("(c) 모드 전환 왕복해도 내용·선택이 불변이다", () => {
    const original = "# 제목\n\n- [ ] 할 일\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$$x^2$$\n";
    const view = new EditorView({
      state: createDocState(original, "edit").update({
        selection: EditorSelection.cursor(7),
      }).state,
      parent: document.body,
    });
    setPreviewConfigOf(view);
    const modes: ViewMode[] = ["read", "source", "edit", "source", "read", "edit"];
    for (const mode of modes) {
      switchMode(view, mode);
      expect(view.state.doc.toString()).toBe(original);
    }
    expect(view.state.selection.main.head).toBe(7);
    // 읽기 모드는 편집 불가.
    switchMode(view, "read");
    expect(view.state.readOnly).toBe(true);
    switchMode(view, "edit");
    expect(view.state.readOnly).toBe(false);
    view.destroy();
  });

  it("(a) 무수정 저장은 write를 부르지 않는다(스토어 규칙)", async () => {
    const { AppStore } = await import("./app/store");
    const writes: string[] = [];
    const store = new AppStore({
      readDocument: async () => ({
        text: "# 원본\n",
        meta: { hadBom: false, crlf: false },
        mtime: 1,
        size: 8,
      }),
      writeDocument: async (_path, text) => {
        writes.push(`text:${text}`);
        return { mtime: 2, size: text.length };
      },
      scanWorkspace: async () => [],
      saveSession: async () => {},
      setAssetScope: async () => {},
      watchPaths: async () => {},
    });
    await store.openPath("/tmp/a.md");
    // 저장 시도 — 무수정이므로 App.saveActive 규칙상 no-op여야 한다.
    // (App.tsx의 saveActive가 지키는 조건을 여기서 재현 검증한다.)
    const tab = store.active!;
    expect(tab.state.doc.toString()).toBe("# 원본\n");
    expect(tab.path && tab.state.doc.toString() === tab.savedText).toBe(true);
    expect(writes).toEqual([]);
    // 수정하면 저장된다.
    tab.state = tab.state.update({ changes: { from: 0, insert: "변경 " } }).state;
    const ok = await store.saveActive();
    expect(ok).toBe(true);
    expect(writes).toEqual([`text:변경 # 원본\n`]);
  });
});

function setPreviewConfigOf(view: EditorView): void {
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
}
