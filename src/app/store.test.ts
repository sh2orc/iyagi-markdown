// 스토어 통합 테스트 — 증분 통계·dirty·토스트·탭 전환이 실제 EditorView와
// 맞물려 돌아가는지(입력 파이프라인 최적화의 회귀 방지).

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";

import { AppStore, countCheckboxes, countWords, type StoreIO } from "./store";
import { setViewListener } from "../editor/cm";
import { previewConfigField } from "../editor/livePreview";
import { DEFAULT_DOC_STYLE } from "./docStyle";
import { hunksOf } from "../editor/trackChanges";
import type { Settings, SettingsSnapshot, BaselineSnapshot, BookmarkSnapshot } from "../api";

function fakeIo(): StoreIO {
  const bookmarks = new Map<string, BookmarkSnapshot>();
  let revision = 0;
  const snapshot = (path: string): BookmarkSnapshot => bookmarks.get(path) ?? {
    text: `# ${path}\n\n샘플 본문입니다.\n`, lines: [], revision,
  };
  return {
    bookmarkList: async (path) => snapshot(path),
    bookmarkSet: async (path, line, present, expectedText) => {
      const current = snapshot(path);
      if (current.text !== expectedText) throw new Error("Bookmark positions changed");
      const lines = new Set(current.lines);
      if (present) lines.add(line); else lines.delete(line);
      const next = { text: current.text, lines: [...lines].sort((a, b) => a - b), revision: ++revision };
      bookmarks.set(path, next);
      return next;
    },
    bookmarkReplace: async (path, text, lines, expected) => {
      const current = snapshot(path);
      if (current.text !== expected.text || JSON.stringify(current.lines) !== JSON.stringify(expected.lines)) throw new Error("Bookmarks changed");
      const next = { text, lines: [...lines], revision: ++revision };
      bookmarks.set(path, next);
      return next;
    },
    readDocument: async (path: string) => ({
      text: `# ${path}\n\n샘플 본문입니다.\n`,
      meta: { hadBom: false, crlf: false },
      mtime: 1,
      size: 10,
    }),
    writeDocument: async (_p: string, text: string) => ({ mtime: 2, size: text.length }),
    scanWorkspace: async () => ({ tree: [], issues: [] }),
    saveSession: async () => {},
    setAssetScope: async () => {},
    watchPaths: async () => {},
  };
}

/** 뷰를 jsdom에 붙이고 스토어와 업데이트 리스너로 잇는다. */
function mount(store: AppStore): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({ parent: host });
  store.view = view;
  setViewListener((update) => store.onDocChanged(update));
  return view;
}

/** rAF 코얼레싱된 emit이 흐르게 한 프레임 기다린다. */
/** rAF가 굶주려도(시스템 부하·타이머 모킹 잔향) 1초 안엔 진행 — 큰 문서
 *  스트레스 테스트가 무한 대기로 시간만 쓰지 않게. */
const nextFrame = () =>
  new Promise<void>((r) => {
    const t = setTimeout(r, 1_000);
    requestAnimationFrame(() => {
      clearTimeout(t);
      r();
    });
  });

async function openTab(store: AppStore, path: string): Promise<void> {
  await store.openPath(path);
  const tab = store.state.tabs.find((t) => t.path === path)!;
  store.view!.setState(tab.state);
  store.state.activeId = tab.id;
}

describe("문서 이동 기록", () => {
  it("닫은 탭의 실제 편집기 선택과 읽기 스크롤을 복원한다", async () => {
    const store = new AppStore(fakeIo()), view = mount(store);
    try {
      await store.openPath("/closed.md", "read");
      const outer = view.dom.parentElement!;
      outer.classList.add("editor-area", "read-mode");
      view.dispatch({ selection: { anchor: 8, head: 2 } });
      view.scrollDOM.scrollTop = 123;
      outer.scrollTop = 456;
      store.closeTab(store.active!.id);
      await store.reopenClosedTab();
      expect(store.active?.path).toBe("/closed.md");
      expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual([8, 2]);
      expect(view.scrollDOM.scrollTop).toBe(123);
      expect(outer.scrollTop).toBe(456);
      expect(store.active?.dirty).toBe(false);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("다른 문서의 링크로 갔다 돌아오면 선택 방향·스크롤을 복원하고 중간 위치를 기록하지 않는다", async () => {
    const store = new AppStore(fakeIo()), view = mount(store);
    try {
      await store.openPath("/a.md");
      const original = view.state.doc;
      const outer = view.dom.parentElement!;
      outer.classList.add("editor-area", "read-mode");
      outer.scrollTop = 234;
      view.dispatch({ selection: { anchor: 5, head: 2 } });
      view.scrollDOM.scrollTop = 123;
      await store.openPath("/b.md", undefined, { line: 3 });
      const destination = view.state.selection.main.head;
      outer.scrollTop = 789;
      expect(store.canNavigateBack).toBe(true);
      store.navigateHistory();
      expect(store.active?.path).toBe("/a.md");
      expect(view.state.doc).toBe(original);
      expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual([5, 2]);
      expect(view.scrollDOM.scrollTop).toBe(123);
      expect(outer.scrollTop).toBe(234);
      expect(store.canNavigateBack).toBe(false);
      expect(store.canNavigateForward).toBe(true);
      store.navigateHistory(true);
      expect(store.active?.path).toBe("/b.md");
      expect(view.state.selection.main.head).toBe(destination);
      expect(outer.scrollTop).toBe(789);
      expect(store.canNavigateForward).toBe(false);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("같은 문서의 이동·편집 보정·새 분기와 누락 앵커를 처리한다", async () => {
    const store = new AppStore(fakeIo()), view = mount(store);
    try {
      await store.openPath("/a.md");
      view.dispatch({ selection: { anchor: 2 } });
      store.revealLocation({ pos: 5 });
      store.revealLocation({ pos: 8 });
      store.navigateHistory();
      expect(view.state.selection.main.head).toBe(5);
      view.dispatch({ changes: { from: 0, insert: "XX" } });
      store.navigateHistory();
      expect(view.state.selection.main.head).toBe(4);
      store.navigateHistory(true);
      expect(view.state.selection.main.head).toBe(7);
      store.revealLocation({ anchor: "missing-heading" });
      expect(store.canNavigateForward).toBe(true);
      expect(view.state.selection.main.head).toBe(7);
      store.revealLocation({ pos: 12 });
      expect(store.canNavigateForward).toBe(false);
      store.navigateHistory();
      expect(view.state.selection.main.head).toBe(7);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("미저장 탭도 탐색하며 닫은 탭과 자동 선택 위치는 제거한다", () => {
    const store = new AppStore(fakeIo()), view = mount(store);
    try {
      store.newTabWithContent("first draft"); const first = store.active!.id;
      view.dispatch({ selection: { anchor: 3 } });
      store.newTabWithContent("second draft"); const second = store.active!.id;
      store.navigateHistory();
      expect(store.active?.id).toBe(first);
      expect(view.state.selection.main.head).toBe(3);
      store.navigateHistory(true);
      store.closeTab(second);
      expect(store.active?.id).toBe(first);
      expect(store.canNavigateBack).toBe(false);
      expect(store.canNavigateForward).toBe(false);
      expect(view.state.doc.toString()).toBe("first draft");
    } finally { view.destroy(); setViewListener(null); }
  });

  it("실패한 열기와 늦은 응답이 이동 기록을 만들거나 뒤로 이동을 되돌리지 않는다", async () => {
    const io = fakeIo(), read = io.readDocument;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    io.readDocument = async (path) => {
      if (path === "/missing.md") throw new Error("missing");
      if (path === "/slow.md") await gate;
      return read(path);
    };
    const store = new AppStore(io), view = mount(store);
    try {
      await store.openPath("/a.md"); await store.openPath("/b.md");
      await store.openPath("/missing.md");
      const pending = store.openPath("/slow.md", undefined, { line: 3 });
      store.navigateHistory();
      release(); await pending;
      expect(store.active?.path).toBe("/a.md");
      expect(store.canNavigateBack).toBe(false);
      store.navigateHistory(true);
      expect(store.active?.path).toBe("/b.md");
      expect(store.canNavigateForward).toBe(false);
    } finally { release(); view.destroy(); setViewListener(null); }
  });
});

describe("AppStore 증분 통계 (입력 파이프라인)", () => {
  it("키 입력마다 words·chars가 델타로 갱신된다", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    await openTab(store, "/tmp/a.md");
    const before = { w: store.active!.words, c: store.active!.chars };
    view.dispatch({ changes: { from: 0, insert: "새 단어 " } });
    view.dispatch({ changes: { from: 0, insert: "x " } });
    await nextFrame();
    const t = store.active!;
    expect(t.dirty).toBe(true);
    expect(t.chars).toBe(before.c + "새 단어 ".length + 2);
    expect(t.words).toBe(countWords(view.state.doc.toString()));
    view.destroy();
    setViewListener(null);
  });

  it("원문 되돌리기(undo 상당)면 dirty가 풀린다(길이 일치 재확정)", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    await openTab(store, "/tmp/b.md");
    expect(store.active!.dirty).toBe(false);
    view.dispatch({ userEvent: "input.type", changes: { from: 0, insert: "편집 " } });
    await nextFrame();
    expect(store.active!.dirty).toBe(true);
    // 되돌리기 — CM undo 명령은 jsdom에서 getClientRects가 없어 측정에 실패하므로
    // 같은 결과(원문 복귀)를 삭제 디스패치로 재현한다.
    view.dispatch({ userEvent: "delete.backward", changes: { from: 0, to: "편집 ".length } });
    await nextFrame();
    expect(view.state.doc.toString()).toBe(store.active!.savedText);
    expect(store.active!.dirty).toBe(false);
    view.destroy();
    setViewListener(null);
  });

  it("같은 길이 교체도 dirty를 정확히 잡는다", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    await openTab(store, "/tmp/c.md");
    const orig = store.active!.savedText;
    view.dispatch({ changes: { from: 0, to: 1, insert: orig[0]! } }); // 같은 글자로 교체
    await nextFrame();
    expect(store.active!.dirty).toBe(false); // 내용 동일 → dirty 아님
    view.dispatch({ changes: { from: 0, to: 1, insert: "Z" } }); // 다른 글자(길이 동일)
    await nextFrame();
    expect(store.active!.dirty).toBe(true);
    view.destroy();
    setViewListener(null);
  });

  it("저장하면 dirty가 풀리고 저장 텍스트 기준이 갱신된다", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    await openTab(store, "/tmp/d.md");
    view.dispatch({ changes: { from: 0, insert: "추가" } });
    await nextFrame();
    expect(await store.saveActive()).toBe(true);
    expect(store.active!.dirty).toBe(false);
    expect(store.active!.savedText.startsWith("추가")).toBe(true);
    view.destroy();
    setViewListener(null);
  });
});

describe("AppStore 탭 전환", () => {
  it("활성 탭의 문서·dirty가 보존되고 전환 후에도 유지된다", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    await openTab(store, "/tmp/one.md");
    await openTab(store, "/tmp/two.md");
    // one 편집(활성 탭을 one으로 맞춘 뒤).
    const one = store.state.tabs.find((t) => t.path === "/tmp/one.md")!;
    view.setState(one.state);
    store.state.activeId = one.id;
    view.dispatch({ changes: { from: 0, insert: "A" } });
    await nextFrame();
    expect(one.dirty).toBe(true);
    // two로 전환 — 뷰는 two의 문서를 보여 준다.
    const two = store.state.tabs.find((t) => t.path === "/tmp/two.md")!;
    store.activate(two.id);
    expect(view.state.doc.toString()).toContain("/tmp/two.md");
    expect(view.state.doc.toString()).not.toContain("A");
    // one으로 복귀 — 편집 내용과 dirty가 살아 있다.
    store.activate(one.id);
    await nextFrame();
    expect(view.state.doc.toString().startsWith("A")).toBe(true);
    expect(one.dirty).toBe(true);
    view.destroy();
    setViewListener(null);
  });
});

describe("책갈피 토글", () => {
  it("저장 성공 후 프리뷰 설정의 책갈피가 갱신된다", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    await openTab(store, "/tmp/mark.md");
    view.dispatch({ selection: { anchor: 3 } }); // 1~2번 줄 아무 데나
    await store.toggleBookmark();
    const cfg = view.state.field(previewConfigField, false);
    expect(cfg?.bookmarks).toEqual([view.state.doc.lineAt(3).number]);
    await store.toggleBookmark(); // 다시 토글 — 제거
    expect(view.state.field(previewConfigField, false)?.bookmarks).toEqual([]);
    view.destroy();
    setViewListener(null);
  });
});

describe("토스트 퇴장", () => {
  it("leaving 표시 뒤 제거된다", async () => {
    vi.useFakeTimers();
    try {
      const store = new AppStore(fakeIo());
      store.toast("안녕");
      expect(store.state.toasts).toHaveLength(1);
      vi.advanceTimersByTime(2600);
      expect(store.state.toasts[0]?.leaving).toBe(true);
      expect(store.state.toasts).toHaveLength(1); // 퇴장 애니메이션 동안 유지
      vi.advanceTimersByTime(250);
      expect(store.state.toasts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("countCheckboxes", () => {
  it("목록 마커 뒤의 [ ]·[x]만 센다", () => {
    expect(countCheckboxes("- [ ] a\n- [x] b\n* [X] c\n1. [ ] d\n")).toEqual({ done: 2, total: 4 });
    expect(countCheckboxes("일반 [ ] 텍스트\n- [x] 항목\n")).toEqual({ done: 1, total: 1 });
    expect(countCheckboxes("문서 없음\n")).toEqual({ done: 0, total: 0 });
  });
});

describe("백링크 배지 (탭 전환 디바운스·캐시)", () => {
  it("활성 탭의 백링크 수를 비동기로 채우고, 재방문은 캐시를 쓴다", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const io = fakeIo();
      io.backlinks = async (_root, path) => {
        calls++;
        return path === "/tmp/a.md" ? [{}, {}, {}] : [{}];
      };
      const store = new AppStore(io);
      mount(store);
      store.state.workspace = "/tmp";
      await openTab(store, "/tmp/a.md");
      await vi.advanceTimersByTimeAsync(500);
      expect(store.active!.backlinks).toBe(3);
      expect(calls).toBe(1);

      await openTab(store, "/tmp/b.md");
      await vi.advanceTimersByTimeAsync(500);
      expect(store.active!.backlinks).toBe(1);
      expect(calls).toBe(2);

      // 되돌아가면 스캔 없이(캐시) 즉시.
      await openTab(store, "/tmp/a.md");
      expect(store.active!.backlinks).toBe(3);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("큰 문서 증분 통계(수동 QA '5MB 문서'의 자동화 근사)", () => {
  it("150k 자 문서에서 20회 편집 후 words/chars가 전체 재계산과 일치", { timeout: 120_000 }, async () => {
    // 500k 자 — 문단 6천 개. jsdom에서 1~2초 내.
    const paras = Array.from({ length: 1500 }, (_, i) => `문단 ${i} — 새 단어 몇 개와 code와 **강조**가 섞인 비교적 긴 문장입니다. `.repeat(2));
    const big = paras.join("\n\n");
    expect(big.length).toBeGreaterThan(100_000);
    const io = fakeIo();
    io.readDocument = async () => ({
      text: big,
      meta: { hadBom: false, crlf: false },
      mtime: 1,
      size: big.length,
    });
    const store = new AppStore(io);
    const view = mount(store);
    await openTab(store, "/tmp/big.md");
    // 증분 경로: 60회의 다양한 편집(삽입·삭제) 후 통계가 전체 재계산과 동일한지.
    for (let i = 0; i < 20; i++) {
      const pos = (i * 7919) % (view.state.doc.length - 1);
      if (i % 3 === 0) {
        view.dispatch({ changes: { from: pos, to: Math.min(pos + 3, view.state.doc.length), insert: "" } });
      } else {
        view.dispatch({ changes: { from: pos, insert: "새 단어 " } });
      }
    }
    // 통계·dirty는 onDocChanged에서 동기 갱신 — rAF 대기 불필요.
    const t = store.active!;
    const finalText = view.state.doc.toString();
    expect(t.chars).toBe(finalText.length);
    expect(t.words).toBe(countWords(finalText));
    expect(t.dirty).toBe(true);
  });
});

describe("책갈피 순환", () => {
  it("커서 위치 기준 다음/이전, 끝에서 반대편으로 랩", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    await openTab(store, "/tmp/bm.md");
    // 문서: 줄 1..5. 책갈피 2·4(토글은 커서 줄 기준 — 커서 옮기며 토글).
    const t = store.active!;
    for (const ln of [2, 4]) {
      const pos = view.state.doc.line(ln).from;
      view.dispatch({ selection: { anchor: pos } });
      await store.toggleBookmark();
    }
    expect(t.bookmarks).toEqual([2, 4]);
    // 커서 1행 → 다음 = 2 → 다음 = 4 → 다음(랩) = 2.
    view.dispatch({ selection: { anchor: 0 } });
    store.cycleBookmark(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    store.cycleBookmark(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
    store.cycleBookmark(true);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(2);
    // 커서 2행 → 이전(랩) = 4.
    store.cycleBookmark(false);
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
  });
});

describe("읽는 중 표시", () => {
  it("시작·중지가 speaking을 토글하고 폴링은 자연 종료를 감지", async () => {
    vi.useFakeTimers();
    try {
      const io = fakeIo();
      let active = true;
      io.speakStart = async () => true;
      io.speakStatus = async () => active;
      io.speakStop = async () => {
        active = false;
      };
      const store = new AppStore(io);
      mount(store);
      await openTab(store, "/tmp/sp.md");
      store.speakActive();
      await vi.advanceTimersByTimeAsync(10);
      expect(store.speaking).toBe(true);
      // 자연 종료(say 끝남) — 폴링이 끈다.
      active = false;
      await vi.advanceTimersByTimeAsync(2100);
      expect(store.speaking).toBe(false);
      // 다시 시작 후 수동 중지.
      active = true;
      store.speakActive();
      await vi.advanceTimersByTimeAsync(10);
      expect(store.speaking).toBe(true);
      store.speakStop();
      expect(store.speaking).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("외부 변경(수동 QA 항목 자동화)", () => {
  it("깨끗한 탭은 자동 다시 읽기·더티 탭은 충돌 표시", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    await openTab(store, "/tmp/ext.md");
    const t = store.active!;

    // 1) 더티 아님 → 자동 다시 읽기(비동기 — 완료 대기)·충돌 없음.
    view.dispatch({ selection: { anchor: 5 } });
    store.syncActiveState();
    store.externalChange("/tmp/ext.md", "changed");
    await new Promise((r) => setTimeout(r, 20));
    await nextFrame();
    expect(t.conflict).toBeNull();
    expect(t.dirty).toBe(false);

    // 2) 더티 + 파일 내용이 저장 내용과 같음(자기 저장 이벤트가 늦게 도착) →
    //    충돌 아님 — 직접 편집 중인데 모달이 뜨는 오남용 방지.
    view.dispatch({ changes: { from: 0, insert: "수정 " } });
    await nextFrame();
    expect(t.dirty).toBe(true);
    store.externalChange("/tmp/ext.md", "changed");
    await new Promise((r) => setTimeout(r, 20));
    expect(t.conflict).toBeNull();

    // 3) 더티 + 파일 내용이 실제로 다름 → 충돌 플래그, 내용 유지.
    (store as unknown as { io: StoreIO }).io.readDocument = async () => ({
      text: "# 외부에서 바뀜\n",
      meta: { hadBom: false, crlf: false },
      mtime: 9,
      size: 1,
    });
    const before = t.state.doc.toString();
    store.externalChange("/tmp/ext.md", "changed");
    await new Promise((r) => setTimeout(r, 20));
    expect(t.conflict).toBe("conflict");
    expect(t.state.doc.toString()).toBe(before);

    // 4) 제거 → removed 표시.
    store.externalChange("/tmp/ext.md", "removed");
    expect(t.conflict).toBe("removed");
  });

  it("자동 저장 진행 중 도착한 자기 fs 이벤트는 충돌 아님(await 전 savedText 경합)", async () => {
    // 재현: 연속 편집 → 자동 저장의 writeDocument가 아직 펜딩인데(저장#1의
    // 늦은 이벤트·부하 시 이벤트가 응답보다 먼저 처리) 디스크는 이미 새 내용.
    // savedText는 예전 내용이라 13차 내용 비교만으로는 뚫린다 — 쓰기 시작
    // 시점의 자기 쓰기 기록(recentSelfWrites)으로 판별해야 한다.
    const io = fakeIo();
    let releaseWrite: (() => void) | null = null;
    io.writeDocument = (_p: string, text: string) =>
      new Promise((resolve) => {
        releaseWrite = () => resolve({ mtime: 3, size: text.length });
      });
    const store = new AppStore(io);
    const view = mount(store);
    await openTab(store, "/tmp/race.md");
    const t = store.active!;
    view.dispatch({ changes: { from: 0, insert: "v2 " } });
    await nextFrame();
    store.syncActiveState();
    expect(t.dirty).toBe(true);

    const saving = store.saveTabById(t.id); // 자동 저장 시작 — writeDocument 펜딩
    // 디스크(=readDocument)는 새 내용, savedText는 예전 내용인 창.
    (store as unknown as { io: StoreIO }).io.readDocument = async () => ({
      text: view.state.doc.toString(),
      meta: { hadBom: false, crlf: false },
      mtime: 3,
      size: 1,
    });
    store.externalChange("/tmp/race.md", "changed");
    await new Promise((r) => setTimeout(r, 20));
    expect(t.conflict).toBeNull(); // 구멍이면 "conflict" → 모달

    releaseWrite!();
    await saving;
    expect(t.dirty).toBe(false);
    expect(t.savedText.startsWith("v2 ")).toBe(true);
    view.destroy();
    setViewListener(null);
  });

  it("소스 미리보기 토글 — 설정 반영·디스크 지속(팔레트 진입)", async () => {
    const io = fakeIo();
    const persisted: unknown[] = [];
    const store = new AppStore(io);
    io.patchSettings = async (patch) => {
      persisted.push(patch);
      return { revision: persisted.length, settings: { ...store.state.settings, ...patch } };
    };
    expect(store.state.settings.sourcePreview).toBe(true); // 기본 켬
    store.toggleSourcePreview();
    expect(store.state.settings.sourcePreview).toBe(false);
    store.toggleSourcePreview();
    expect(store.state.settings.sourcePreview).toBe(true);
    expect(persisted).toEqual([]);
    await store.flushSettings();
    expect(persisted).toEqual([{ sourcePreview: true }]);
    expect(store.state.settingsPending).toBe(false);
  });
});

describe("자동 저장 실패 알림(조용한 유실 방지)", () => {
  it("실패 시 에러 토스트 — 연속 실패 중복 억제·회복 후 재실패 재알림", async () => {
    const io = fakeIo();
    const diskFull = () => Promise.reject(new Error("disk full"));
    io.writeDocument = diskFull;
    const store = new AppStore(io);
    const view = mount(store);
    await openTab(store, "/tmp/autosave-fail.md");
    const t = store.active!;
    view.dispatch({ changes: { from: 0, insert: "x" } });
    await nextFrame();
    const errs = () => store.state.toasts.filter((x) => x.kind === "error");
    expect(await store.saveTabById(t.id)).toBe(false);
    expect(errs()).toHaveLength(1); // 첫 실패 알림
    expect(t.dirty).toBe(true); // dirty 유지 — 다음 입력에 재시도
    expect(await store.saveTabById(t.id)).toBe(false);
    expect(errs()).toHaveLength(1); // 연속 실패 — 중복 억제
    io.writeDocument = async (_p: string, text: string) => ({ mtime: 5, size: text.length });
    expect(await store.saveTabById(t.id)).toBe(true); // 회복
    expect(t.dirty).toBe(false);
    io.writeDocument = diskFull;
    view.dispatch({ changes: { from: 0, insert: "y" } });
    await nextFrame();
    expect(await store.saveTabById(t.id)).toBe(false); // 재실패
    expect(errs()).toHaveLength(2); // 회복 후 재알림
    view.destroy();
    setViewListener(null);
  });
});

describe("TTS 시작 실패 피드백", () => {
  it("speakStart=false면 에러 토스트(조용한 무반응 방지)", async () => {
    const io = fakeIo();
    io.speakStart = async () => false;
    const store = new AppStore(io);
    const view = mount(store);
    await openTab(store, "/tmp/tts-fail.md");
    store.speakActive();
    await new Promise((r) => setTimeout(r, 10));
    const errs = store.state.toasts.filter((x) => x.kind === "error");
    expect(errs).toHaveLength(1);
    expect(errs[0]?.text).toContain("reading aloud");
    expect(store.speaking).toBe(false);
    view.destroy();
    setViewListener(null);
  });
});

describe("세션 복원 중 저장 억제(재시작 후 초기 화면 방지)", () => {
  it("워크스페이스 열기가 예약한 저장이 문서 읽기보다 먼저 돌아도 빈 탭 세션을 쓰지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const saved: { tabs: unknown[]; active: string | null }[] = [];
      const io = fakeIo();
      io.saveSession = async (s) => {
        saved.push({ tabs: s.tabs, active: s.active });
      };
      // 문서 읽기가 디바운스(800ms)보다 느린 상황(큰 문서·디버그 빌드 IPC).
      const read = io.readDocument;
      io.readDocument = (p: string) =>
        new Promise((r) => setTimeout(() => void read(p).then(r), 2_000));
      const store = new AppStore(io);
      const done = store.restoreSession({
        version: 1,
        tabs: [{ path: "/w/a.md", mode: "edit", cursor: 0, scroll: 0 }],
        active: "/w/a.md",
        workspace: "/w",
        sidebarOpen: true,
        tocOpen: true,
      } as Parameters<AppStore["restoreSession"]>[0]);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(saved).toEqual([]); // 복원 도중 — 탭 없는 세션 기록 금지
      await vi.advanceTimersByTimeAsync(1_000);
      await done;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(saved.length).toBeGreaterThan(0);
      // 새 세션 형식: active가 document UUID(경로 아님) — 형식만 검증.
      expect(saved.at(-1)?.active ?? "").toMatch(/^document:/);
      expect(saved.every((s) => s.tabs.length > 0)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("최근 파일 상태 갱신(loadRecent)", () => {
  it("restoreSession 뒤 Rust 목록으로 state.recent를 채운다 — 사이드바 데이터", async () => {
    const io = fakeIo();
    io.getRecent = async () => ({ revision: 1, entries: [{ path: "/tmp/r1.md", name: "r1.md" }] });
    const store = new AppStore(io);
    expect(store.state.recent).toHaveLength(0); // 그동안 이 값이 영원히 비어 있었다
    await store.restoreSession({
      version: 1,
      tabs: [],
      active: null,
      workspace: null,
      sidebarOpen: true,
      sidebarWidth: 240,
      tocOpen: true,
      window: null,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(store.state.recent).toHaveLength(1);
    expect(store.state.recent[0]?.name).toBe("r1.md");
  });
});

describe("이미지 가져오기 대상과 삽입 위치", () => {
  it("입력에 따라 위치를 보정하고 이동한 커서를 빼앗지 않는다", async () => {
    const io = fakeIo();
    let release!: (path: string) => void;
    io.importImage = () => new Promise((resolve) => { release = resolve; });
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await store.openPath("/tmp/a.md");
      const before = view.state.doc.toString();
      view.dispatch({ selection: { anchor: before.length } });
      const pending = store.importImages(view, ["/source.png"]);
      view.dispatch({ changes: { from: 0, insert: "새 입력\n" }, selection: { anchor: 0 } });
      release("/tmp/assets/a #%.png");
      await pending;
      expect(view.state.doc.toString()).toBe(`새 입력\n${before}![](assets/a%20%23%25.png)\n`);
      expect(view.state.selection.main.head).toBe(0);
    } finally { view.destroy(); setViewListener(null); }
  });

  it.each(["switch", "edit-range", "lock", "rename", "close"])("복사 대기 중 %s 이후 본문을 바꾸지 않는다", async (change) => {
    const io = fakeIo();
    let release!: (path: string) => void;
    io.importImage = () => new Promise((resolve) => { release = resolve; });
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await store.openPath("/tmp/a.md");
      view.dispatch({ selection: { anchor: 0, head: 2 } });
      const pending = store.importImages(view, ["/source.png"]);
      if (change === "switch") store.newTab();
      else if (change === "edit-range") view.dispatch({ changes: { from: 0, to: 2, insert: "수정" } });
      else if (change === "lock") store.setLocked(store.active!.id, true);
      else if (change === "rename") store.active!.path = "/tmp/renamed.md";
      else store.closeTab(store.active!.id);
      const before = view.state.doc.toString();
      release("/tmp/assets/copied.png");
      await pending;
      expect(view.state.doc.toString()).toBe(before);
      expect(store.state.toasts.some((toast) => toast.text.includes("/tmp/assets/copied.png"))).toBe(true);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("파일 선택창을 열기 전에 대상을 고정하고 바뀌면 복사를 시작하지 않는다", async () => {
    const io = fakeIo();
    io.importImage = vi.fn(async () => "/tmp/assets/a.png");
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await store.openPath("/tmp/a.md");
      let select!: (path: string) => void;
      const pending = store.importImages(view, () => new Promise((resolve) => { select = resolve; }));
      store.newTab();
      select("/source.png");
      await pending;
      expect(io.importImage).not.toHaveBeenCalled();
      expect(view.state.doc.length).toBe(0);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("성공한 이미지만 순서대로 한 번에 삽입하며 부분 실패를 알린다", async () => {
    const io = fakeIo();
    io.importImage = vi.fn(async (path) => {
      if (path === "/bad.png") throw new Error("Unreadable");
      return `/tmp/assets${path}`;
    });
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await store.openPath("/tmp/a.md");
      const before = view.state.doc.toString();
      view.dispatch({ selection: { anchor: 0, head: 2 } });
      await store.importImages(view, ["/one.png", "/bad.png", "/two.png"]);
      expect(view.state.doc.toString()).toBe(`![](assets/one.png)\n![](assets/two.png)\n${before.slice(2)}`);
      expect(store.state.toasts.some((toast) => toast.text.includes("/bad.png"))).toBe(true);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(before);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("중복 요청·읽기 전용·배치 상한은 파일 복사 전에 막는다", async () => {
    const io = fakeIo();
    let release!: (path: string) => void;
    io.importImage = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await store.openPath("/tmp/a.md");
      store.setLocked(store.active!.id, true);
      await store.importImages(view, ["/locked.png"]);
      store.setLocked(store.active!.id, false);
      await store.importImages(view, Array(33).fill("/many.png"));
      expect(io.importImage).not.toHaveBeenCalled();
      const pending = store.importImages(view, ["/one.png"]);
      await store.importImages(view, ["/two.png"]);
      expect(io.importImage).toHaveBeenCalledTimes(1);
      release("/tmp/assets/one.png");
      await pending;
    } finally { view.destroy(); setViewListener(null); }
  });

  it("클립보드 실패를 알리고 현재 문서에 대체 텍스트를 쓰지 않는다", async () => {
    const io = fakeIo();
    io.saveImageBytes = async () => { throw new Error("Clipboard unavailable"); };
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await store.openPath("/tmp/a.md");
      const before = view.state.doc.toString();
      const blob = new Blob(["image"], { type: "image/png" });
      Object.defineProperty(blob, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]).buffer });
      await store.importImages(view, blob);
      expect(view.state.doc.toString()).toBe(before);
      expect(store.state.toasts.some((toast) => toast.text.includes("Clipboard unavailable"))).toBe(true);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("붙여넣기 이벤트의 바이트와 MIME을 저장하고 Blob을 읽는 동안 바뀐 대상에는 쓰지 않는다", async () => {
    const io = fakeIo();
    io.saveImageBytes = vi.fn(async () => "/tmp/assets/paste.png");
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await store.openPath("/tmp/a.md");
      const bytes = new Uint8Array([1, 2, 3]);
      const blob = new Blob([bytes], { type: "image/png" });
      Object.defineProperty(blob, "arrayBuffer", { value: async () => bytes.buffer });
      await store.importImages(view, blob);
      expect(io.saveImageBytes).toHaveBeenCalledWith("/tmp", "image/png", bytes);
      let read!: (bytes: ArrayBuffer) => void;
      const waiting = new Blob([bytes], { type: "image/png" });
      Object.defineProperty(waiting, "arrayBuffer", { value: () => new Promise<ArrayBuffer>((resolve) => { read = resolve; }) });
      const pending = store.importImages(view, waiting);
      store.newTab();
      read(bytes.buffer);
      await pending;
      expect(io.saveImageBytes).toHaveBeenCalledTimes(1);
      expect(view.state.doc.length).toBe(0);
    } finally { view.destroy(); setViewListener(null); }
  });
});

describe("openPath 동시 열기(경합)", () => {
  it("늦게 끝난 읽기는 더 최근에 요청한 문서와 커서를 바꾸지 않는다", async () => {
    const io = fakeIo();
    const read = io.readDocument;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    io.readDocument = async (path) => {
      if (path === "/slow.md") await gate;
      return read(path);
    };
    const store = new AppStore(io);
    const view = mount(store);
    try {
      const slow = store.openPath("/slow.md", undefined, { line: 1 });
      await store.openPath("/latest.md", undefined, { line: 3 });
      const pos = view.state.selection.main.head;
      release();
      await slow;
      expect(store.active?.path).toBe("/latest.md");
      expect(view.state.selection.main.head).toBe(pos);
      expect(store.state.tabs.some((tab) => tab.path === "/slow.md")).toBe(true);
    } finally { release(); view.destroy(); setViewListener(null); }
  });

  it.each(["activate", "new", "close", "anchor"])("읽기 대기 중 %s 탐색을 보존한다", async (action) => {
    const io = fakeIo();
    const read = io.readDocument;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    io.readDocument = async (path) => {
      if (path === "/slow.md") await gate;
      return read(path);
    };
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await store.openPath("/current.md");
      const pending = store.openPath("/slow.md", undefined, { line: 3 });
      if (action === "activate") store.activate(store.active!.id);
      else if (action === "new") store.newTab();
      else if (action === "close") store.closeTab(store.active!.id);
      else store.revealLocation({ anchor: "" });
      const chosen = store.state.activeId;
      release();
      await pending;
      expect(store.state.activeId).toBe(chosen);
    } finally { release(); view.destroy(); setViewListener(null); }
  });

  it("열기 실패 시 현재 문서에 결과 줄을 적용하지 않는다", async () => {
    const io = fakeIo();
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await store.openPath("/current.md");
      view.dispatch({ selection: { anchor: 2 } });
      io.readDocument = async () => { throw new Error("missing"); };
      await store.openPath("/missing.md", undefined, { line: 3 });
      expect(store.active?.path).toBe("/current.md");
      expect(view.state.selection.main.head).toBe(2);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("같은 파일의 동시 이동은 읽기를 공유하고 마지막 목적지를 적용한다", async () => {
    const io = fakeIo();
    io.readDocument = vi.fn(io.readDocument);
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await Promise.all([
        store.openPath("/same.md", undefined, { line: 1 }),
        store.openPath("/same.md", undefined, { line: 3 }),
      ]);
      expect(io.readDocument).toHaveBeenCalledTimes(1);
      expect(store.state.tabs).toHaveLength(1);
      expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("다른 문서의 중복 제목·한글 제목으로 이동하고 접두사 오일치를 피한다", async () => {
    const io = fakeIo();
    const text = "# overview-extra\n\n# overview\n\n# overview\n\n# 한글 제목\n";
    io.readDocument = async () => ({ text, meta: { hadBom: false, crlf: false }, mtime: 1, size: text.length });
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await store.openPath("/headings.md", undefined, { anchor: "overview" });
      expect(view.state.selection.main.head).toBe(text.indexOf("# overview\n"));
      await store.openPath("/headings.md", undefined, { anchor: "overview-1" });
      expect(view.state.selection.main.head).toBe(text.lastIndexOf("# overview\n"));
      store.revealLocation({ anchor: "한글 제목" });
      expect(view.state.selection.main.head).toBe(text.indexOf("# 한글"));
      store.revealLocation({ anchor: "over" });
      expect(view.state.selection.main.head).toBe(text.indexOf("# 한글"));
      store.revealLocation({ anchor: "" });
      expect(view.state.selection.main.head).toBe(0);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("목적지 이동 후 지연된 이전 스크롤 복원이 실행되지 않는다", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    try {
      await store.openPath("/scroll.md");
      const writes: Array<() => void> = [];
      vi.spyOn(view, "requestMeasure").mockImplementation((request) => {
        if (request?.write) writes.push(() => request.write!(request.read(view), view));
      });
      store.active!.scroll = 400;
      store.activate(store.active!.id);
      store.revealLocation({ line: 3 });
      view.scrollDOM.scrollTop = 80;
      for (const write of writes) write();
      expect(view.scrollDOM.scrollTop).toBe(80);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("같은 경로를 겹쳐 열면 탭이 2개 생기지 않는다(더블클릭·두 번 Enter)", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    // 첫 호출이 readDocument를 기다리는 동안 두 번째가 들어온다 — 둘 다
    // settle 전에는 탭이 없으므로 동기 중복 체크만으로는 못 막는 창.
    const [a, b] = [store.openPath("/tmp/race.md"), store.openPath("/tmp/race.md")];
    await Promise.all([a, b]);
    await nextFrame();
    const tabs = store.state.tabs.filter((t) => t.path === "/tmp/race.md");
    expect(tabs.length).toBe(1);
    view.destroy();
  });
});

describe("작성 초안 임시저장(drafts.db 안전망)", () => {
  it("미저장 입력은 디바운스 뒤 초안으로 — 제목 없는 탭은 untitled 키", async () => {
    const io = fakeIo();
    const saved: Array<{ key: string; path: string | null; content: string }> = [];
    io.draftSave = async (d) => {
      saved.push({ key: d.key, path: d.path, content: d.content });
    };
    const store = new AppStore(io);
    const view = mount(store);
    store.newTab();
    const tab = store.state.tabs[0];
    store.state.activeId = tab.id;
    view.setState(tab.state);
    view.dispatch({ changes: { from: 0, insert: "작성 중인 내용" } });
    expect(saved.length).toBe(0); // 아직 디바운스 창
    await new Promise((r) => setTimeout(r, 1700));
    expect(saved.length).toBe(1);
    expect(saved[0].key.startsWith("untitled:")).toBe(true);
    expect(saved[0].path).toBeNull();
    expect(saved[0].content).toContain("작성 중인 내용");
    view.destroy();
  }, 8000);

  it("파일 탭 저장 시 초안이 지워진다", async () => {
    const io = fakeIo();
    const cleared: string[] = [];
    io.draftSave = async () => {};
    io.draftClear = async (k) => {
      cleared.push(k);
    };
    const store = new AppStore(io);
    const view = mount(store);
    await openTab(store, "/tmp/draft.md");
    view.dispatch({ changes: { from: 0, insert: "수정" } });
    expect(await store.saveTabById(store.state.tabs[0].id)).toBe(true);
    expect(cleared).toContain(store.active!.draftKey);
    expect(cleared).not.toContain("/tmp/draft.md");
    view.destroy();
  });

  it("세션 복원 — 파일 탭의 초안이 더티로 덧입혀진다(진실 기준은 디스크)", async () => {
    const io = fakeIo();
    io.draftLoad = async (key) =>
      key === "/tmp/a.md"
        ? { key, path: "/tmp/a.md", content: "# 제목\n\n초안 덧입힘", cursor: 5, scroll: 10, updatedAt: 1 }
        : null;
    const store = new AppStore(io);
    await store.restoreSession({
      version: 1,
      tabs: [{ path: "/tmp/a.md", draftKey: null, mode: "edit", cursor: 0, scroll: 0 }],
      active: "/tmp/a.md",
      workspace: null,
      sidebarOpen: true,
      sidebarWidth: 240,
      tocOpen: true,
      window: null,
      auxWindow: null,
    });
    const tab = store.state.tabs.find((t) => t.path === "/tmp/a.md")!;
    expect(tab.dirty).toBe(true);
    expect(tab.state.doc.toString()).toContain("초안 덧입힘");
    expect(tab.savedText).toContain("샘플 본문"); // savedText=디스크 원문
    expect(tab.state.selection.main.head).toBe(5); // 초안 커서
  });

  it("세션 복원 — 제목 없는 탭 초안을 복원하고 임의 삭제하지 않는다", async () => {
    const io = fakeIo();
    io.draftLoad = async (key) =>
      key === "untitled:z"
        ? { key, path: null, content: "새 문서 초안", cursor: 3, scroll: 0, updatedAt: 1 }
        : null;
    const cleared: string[] = [];
    io.draftClear = async (key) => { cleared.push(key); };
    const store = new AppStore(io);
    await store.restoreSession({
      version: 1,
      tabs: [{ path: null, draftKey: "untitled:z", mode: "edit", cursor: 0, scroll: 0 }],
      active: null,
      workspace: null,
      sidebarOpen: true,
      sidebarWidth: 240,
      tocOpen: true,
      window: null,
      auxWindow: null,
    });
    const t = store.state.tabs.find((x) => x.draftKey === "untitled:z");
    expect(t).toBeTruthy();
    expect(t!.state.doc.toString()).toBe("새 문서 초안");
    expect(t!.dirty).toBe(true);
    expect(cleared).toEqual([]);
  });
});

describe("탭별 자동 저장과 복구 초안", () => {
  it("여러 탭의 초안 예약은 서로 취소하지 않고 커서 이동은 저장을 미루지 않는다", async () => {
    vi.useFakeTimers();
    const io = fakeIo();
    const drafts = new Map<string, string>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    const store = new AppStore(io), view = mount(store);
    store.setSettings({ ...store.state.settings, autosave: false });
    try {
      await store.openPath("/first-draft.md");
      const first = store.active!;
      view.dispatch({ changes: { from: 0, insert: "first " } });
      await vi.advanceTimersByTimeAsync(700);
      await store.openPath("/second-draft.md");
      const second = store.active!;
      view.dispatch({ changes: { from: 0, insert: "second " } });
      await vi.advanceTimersByTimeAsync(800);
      expect(drafts.get(first.draftKey!)).toBe(first.state.doc.toString());
      expect(drafts.has(second.draftKey!)).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      view.dispatch({ selection: { anchor: 2 } });
      await vi.advanceTimersByTimeAsync(100);
      expect(drafts.get(second.draftKey!)).toBe(second.state.doc.toString());
    } finally {
      view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("분할 편집의 각 문서는 초안과 할 일·변경 추적 숫자를 따로 갱신한다", async () => {
    vi.useFakeTimers();
    const io = fakeIo(), drafts = new Map<string, string>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    const store = new AppStore(io), view = mount(store);
    store.setSettings({ ...store.state.settings, autosave: false });
    let split: EditorView | null = null;
    try {
      await store.openPath("/split-first.md");
      const first = store.active!;
      await store.openPath("/split-second.md");
      const second = store.active!;
      first.baselineText = first.state.doc.toString();
      second.baselineText = second.state.doc.toString();
      const host = document.createElement("div");
      document.body.append(host);
      split = new EditorView({ state: first.state, parent: host });
      store.splitView = split; store.splitTabId = first.id;
      split.dispatch({ changes: { from: 0, insert: "- [x] first\n" } });
      await vi.advanceTimersByTimeAsync(100);
      view.dispatch({ changes: { from: 0, insert: "- [ ] second\n" } });
      await vi.advanceTimersByTimeAsync(300);
      expect(first.checkbox).toEqual({ done: 1, total: 1 });
      expect(second.checkbox).toEqual({ done: 0, total: 1 });
      expect(first.trackStats!.added).toBeGreaterThan(0);
      expect(second.trackStats!.added).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1200);
      expect(drafts.get(first.draftKey!)).toBe(first.state.doc.toString());
      expect(drafts.get(second.draftKey!)).toBe(second.state.doc.toString());
    } finally {
      store.splitView = null; store.splitTabId = null;
      split?.destroy(); view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("여러 파일의 자동 저장은 각각 마지막 입력 시점을 따른다", async () => {
    vi.useFakeTimers();
    const io = fakeIo();
    const writes: Array<{ path: string; text: string }> = [];
    io.writeDocument = async (path, text) => {
      writes.push({ path, text });
      return { mtime: 2, size: text.length };
    };
    const store = new AppStore(io), view = mount(store);
    try {
      await store.openPath("/first-auto.md");
      const first = store.active!;
      view.dispatch({ changes: { from: 0, insert: "first " } });
      await vi.advanceTimersByTimeAsync(700);
      await store.openPath("/second-auto.md");
      const second = store.active!;
      view.dispatch({ changes: { from: 0, insert: "second " } });
      await vi.advanceTimersByTimeAsync(800);
      expect(writes).toEqual([{ path: first.path, text: first.state.doc.toString() }]);
      await vi.advanceTimersByTimeAsync(700);
      expect(writes).toEqual([
        { path: first.path, text: first.state.doc.toString() },
        { path: second.path, text: second.state.doc.toString() },
      ]);
    } finally {
      view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("자동 저장을 끄면 대기 중인 저장을 취소하고 다시 켜면 미저장 파일을 저장한다", async () => {
    vi.useFakeTimers();
    const io = fakeIo();
    const writes = vi.fn(io.writeDocument);
    io.writeDocument = writes;
    const store = new AppStore(io), view = mount(store);
    try {
      await store.openPath("/autosave-setting.md");
      view.dispatch({ changes: { from: 0, insert: "edit " } });
      store.setSettings({ ...store.state.settings, autosave: false });
      await vi.advanceTimersByTimeAsync(1500);
      expect(writes).not.toHaveBeenCalled();
      store.setSettings({ ...store.state.settings, autosave: true });
      await vi.advanceTimersByTimeAsync(1500);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(writes.mock.calls[0][1]).toBe(view.state.doc.toString());
    } finally {
      view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("자동 저장을 끄면 진행 중인 수동 저장 뒤에 줄 선 자동 저장도 실행하지 않는다", async () => {
    vi.useFakeTimers();
    const io = fakeIo(), writes: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    io.writeDocument = async (_path, text) => {
      writes.push(text);
      if (writes.length === 1) await gate;
      return { mtime: 2, size: text.length };
    };
    const store = new AppStore(io), view = mount(store);
    try {
      await store.openPath("/queued-auto.md");
      view.dispatch({ changes: { from: 0, insert: "first " } });
      const saving = store.saveActive();
      view.dispatch({ changes: { from: 0, insert: "second " } });
      await vi.advanceTimersByTimeAsync(1500);
      store.setSettings({ ...store.state.settings, autosave: false });
      release();
      await saving;
      await store.settleDocumentWrites();
      expect(writes).toHaveLength(1);
      expect(store.active?.dirty).toBe(true);
    } finally {
      release(); view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("종료 준비에서 중단한 여러 탭의 자동 저장은 취소 후 다시 예약할 수 있다", async () => {
    vi.useFakeTimers();
    const io = fakeIo(), writes: string[] = [];
    io.writeDocument = async (path, text) => { writes.push(path); return { mtime: 2, size: text.length }; };
    const store = new AppStore(io), view = mount(store);
    try {
      await store.openPath("/close-first.md");
      view.dispatch({ changes: { from: 0, insert: "first " } });
      await store.openPath("/close-second.md");
      view.dispatch({ changes: { from: 0, insert: "second " } });
      await store.settleDocumentWrites();
      await vi.advanceTimersByTimeAsync(1500);
      expect(writes).toEqual([]);
      store.resumeAutosaves();
      await vi.advanceTimersByTimeAsync(1500);
      expect(writes.sort()).toEqual(["/close-first.md", "/close-second.md"]);
    } finally {
      view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("원래 내용으로 되돌리면 예약된 초안 쓰기가 끝난 뒤 낡은 초안을 지운다", async () => {
    vi.useFakeTimers();
    const io = fakeIo(), drafts = new Map<string, string>();
    let release!: () => void;
    let started!: () => void;
    const startedSaving = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    io.draftSave = async (draft) => { started(); await gate; drafts.set(draft.key, draft.content); };
    io.draftClear = async (key) => { drafts.delete(key); };
    const store = new AppStore(io), view = mount(store);
    store.setSettings({ ...store.state.settings, autosave: false });
    try {
      await store.openPath("/undo-draft.md");
      const tab = store.active!;
      view.dispatch({ changes: { from: 0, insert: "edit " } });
      await vi.advanceTimersByTimeAsync(1500);
      await startedSaving;
      view.dispatch({ changes: { from: 0, to: 5 } });
      expect(tab.dirty).toBe(false);
      const flushing = store.flushDrafts();
      release();
      await flushing;
      expect(drafts.has(tab.draftKey!)).toBe(false);
    } finally {
      release(); view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("되돌린 문서의 초안 삭제가 실패하면 종료 전 다시 시도한다", async () => {
    vi.useFakeTimers();
    const io = fakeIo(), drafts = new Map<string, string>();
    let failClear = true;
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    io.draftClear = async (key) => {
      if (failClear) throw new Error("database locked");
      drafts.delete(key);
    };
    const store = new AppStore(io), view = mount(store);
    store.setSettings({ ...store.state.settings, autosave: false });
    try {
      await store.openPath("/undo-retry.md");
      const tab = store.active!;
      view.dispatch({ changes: { from: 0, insert: "edit " } });
      await vi.advanceTimersByTimeAsync(1500);
      view.dispatch({ changes: { from: 0, to: 5 } });
      await vi.advanceTimersByTimeAsync(1500);
      expect(drafts.has(tab.draftKey!)).toBe(true);
      expect(store.state.toasts.some((toast) => toast.kind === "error")).toBe(true);
      failClear = false;
      await store.flushDrafts();
      expect(drafts.has(tab.draftKey!)).toBe(false);
    } finally {
      view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("버리기를 선택하면 대기 중인 제목 없는 문서의 초안을 종료 시 다시 만들지 않는다", async () => {
    vi.useFakeTimers();
    const io = fakeIo(), drafts = new Map<string, string>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    io.draftClear = async (key) => { drafts.delete(key); };
    const store = new AppStore(io), view = mount(store);
    try {
      store.newTab();
      const tab = store.active!;
      view.dispatch({ changes: { from: 0, insert: "first" } });
      await store.flushDrafts();
      view.dispatch({ changes: { from: 5, insert: " second" } });
      await store.discardDocuments([tab.id]);
      await store.flushDrafts();
      await vi.advanceTimersByTimeAsync(1500);
      expect(drafts.has(tab.draftKey!)).toBe(false);
      expect(tab.dirty).toBe(false);
    } finally {
      view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("진행 중인 저장을 기다리던 초안 정리가 버린 내용을 되살리지 않는다", async () => {
    vi.useFakeTimers();
    const io = fakeIo(), drafts = new Map<string, string>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    io.draftClear = async (key) => { drafts.delete(key); };
    io.writeDocument = async (_path, text) => { await gate; return { mtime: 2, size: text.length }; };
    const store = new AppStore(io), view = mount(store);
    try {
      await store.openPath("/discard-pending.md");
      const tab = store.active!, original = view.state.doc.toString();
      view.dispatch({ changes: { from: 0, insert: "edit " } });
      const saving = store.saveActive();
      view.dispatch({ changes: { from: 0, to: 5 } });
      await vi.advanceTimersByTimeAsync(1500);
      expect(drafts.get(tab.draftKey!)).toBe(original);
      const discarding = store.discardDocuments([tab.id]);
      release();
      await saving;
      await discarding;
      await store.flushDrafts();
      await vi.advanceTimersByTimeAsync(1500);
      expect(drafts.has(tab.draftKey!)).toBe(false);
    } finally {
      release(); view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("제목 없는 문서를 비우면 이전 초안 대신 빈 문서와 스타일을 복구한다", async () => {
    vi.useFakeTimers();
    const io = fakeIo(), drafts = new Map<string, import("../api").Draft>();
    const styles = new Map<string, string>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft); };
    io.draftLoad = async (key) => drafts.get(key) ?? null;
    io.docStyleSet = async (key, json) => { styles.set(key, json); };
    io.docStyleGet = async (key) => styles.get(key) ?? null;
    const store = new AppStore(io), view = mount(store);
    try {
      store.newTab();
      store.setDocStyle(styleWithSize(23));
      view.dispatch({ changes: { from: 0, insert: "temporary" } });
      await vi.advanceTimersByTimeAsync(1500);
      view.dispatch({ changes: { from: 0, to: 9 } });
      await store.flushDrafts();
      const session = store.buildSession(), key = session.tabs[0].draftKey!;
      expect(drafts.get(key)?.content).toBe("");
      const restored = new AppStore(io);
      await restored.restoreSession(session);
      expect(restored.active?.state.doc.toString()).toBe("");
      expect(restored.active?.dirty).toBe(true);
      expect(restored.active?.docStyle?.fontSize).toBe(23);
    } finally {
      view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("삭제된 파일을 편집 후 되돌려도 복구 내용과 미저장 표시를 유지한다", async () => {
    vi.useFakeTimers();
    const io = fakeIo(), drafts = new Map<string, string>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    const store = new AppStore(io), view = mount(store);
    try {
      await store.openPath("/removed-draft.md");
      const tab = store.active!, original = view.state.doc.toString();
      store.externalChange(tab.path!, "removed");
      view.dispatch({ changes: { from: 0, insert: "edit " } });
      view.dispatch({ changes: { from: 0, to: 5 } });
      expect(tab.dirty).toBe(true);
      await vi.advanceTimersByTimeAsync(1500);
      expect(drafts.get(tab.draftKey!)).toBe(original);
      expect(tab.conflict).toBe("removed");
    } finally {
      view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });

  it("내 내용을 유지하기로 한 문서는 원래 텍스트로 돌아와도 명시적 저장이 필요하다", async () => {
    const io = fakeIo(), writes = vi.fn(io.writeDocument);
    io.writeDocument = writes;
    io.draftSave = async () => {};
    const store = new AppStore(io), view = mount(store);
    try {
      await store.openPath("/keep-removed.md");
      const tab = store.active!, original = view.state.doc.toString();
      store.externalChange(tab.path!, "removed");
      expect((await store.keepMine(tab.id)).status).toBe("applied");
      view.dispatch({ changes: { from: 0, insert: "edit " } });
      view.dispatch({ changes: { from: 0, to: 5 } });
      expect(tab.dirty).toBe(true);
      expect(await store.saveActive()).toBe(true);
      expect(writes).toHaveBeenCalledWith(tab.path, original, tab.meta, { kind: "missing" });
    } finally { view.destroy(); setViewListener(null); }
  });

  it("저장 중 원래 내용으로 되돌린 편집도 복구하고 이어서 자동 저장한다", async () => {
    vi.useFakeTimers();
    const io = fakeIo(), drafts = new Map<string, string>(), writes: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    io.draftClear = async (key) => { drafts.delete(key); };
    io.writeDocument = async (_path, text) => {
      writes.push(text);
      if (writes.length === 1) await gate;
      return { mtime: 2, size: text.length };
    };
    const store = new AppStore(io), view = mount(store);
    try {
      await store.openPath("/save-undo.md");
      const tab = store.active!, original = view.state.doc.toString();
      view.dispatch({ changes: { from: 0, insert: "edit " } });
      const saving = store.saveActive();
      view.dispatch({ changes: { from: 0, to: 5 } });
      await vi.advanceTimersByTimeAsync(1500);
      expect(drafts.get(tab.draftKey!)).toBe(original);
      release();
      expect(await saving).toBe(true);
      expect(tab.dirty).toBe(true);
      await vi.advanceTimersByTimeAsync(1500);
      expect(writes).toEqual([`edit ${original}`, original]);
      expect(tab.dirty).toBe(false);
    } finally {
      release(); view.destroy(); setViewListener(null); vi.clearAllTimers(); vi.useRealTimers();
    }
  });
});

describe("저장 중 편집과 문서 정체성 보존", () => {
  for (const automatic of [false, true]) {
    it(`${automatic ? "자동" : "수동"} 저장 응답이 늦어도 이후 편집과 복구 초안을 남긴다`, async () => {
      const io = fakeIo();
      let finish!: () => void;
      const drafts: string[] = [];
      io.draftSave = async (draft) => { drafts.push(draft.content); };
      io.writeDocument = (_path, text) => new Promise((resolve) => {
        finish = () => resolve({ mtime: 2, size: text.length });
      });
      const store = new AppStore(io);
      await store.openPath("/tmp/save-race.md");
      const tab = store.active!;
      tab.state = tab.state.update({ changes: { from: 0, insert: "first " } }).state;
      tab.dirty = true;
      const submitted = tab.state.doc.toString();
      const saving = automatic ? store.saveTabById(tab.id) : store.saveActive();
      tab.state = tab.state.update({ changes: { from: 0, insert: "second " } }).state;
      finish();
      expect(await saving).toBe(true);
      expect(tab.savedText).toBe(submitted);
      expect(tab.dirty).toBe(true);
      expect(drafts.at(-1)).toBe(tab.state.doc.toString());
    });
  }

  it("동시 저장 요청은 순서대로 쓰고 두 번째 요청은 최신 버퍼를 저장한다", async () => {
    const io = fakeIo();
    let finish!: () => void;
    const writes: string[] = [];
    io.writeDocument = async (_path, text) => {
      writes.push(text);
      if (writes.length === 1) await new Promise<void>((resolve) => { finish = resolve; });
      return { mtime: writes.length, size: text.length };
    };
    const store = new AppStore(io);
    await store.openPath("/tmp/queued.md");
    const tab = store.active!;
    tab.state = tab.state.update({ changes: { from: 0, insert: "one " } }).state;
    tab.dirty = true;
    const first = store.saveActive();
    tab.state = tab.state.update({ changes: { from: 0, insert: "two " } }).state;
    const second = store.saveTabById(tab.id);
    expect(writes).toHaveLength(1);
    finish();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(tab.state.doc.toString());
    expect(tab.dirty).toBe(false);
  });

  it("충돌이 남은 문서는 자동 저장하지 않는다", async () => {
    const io = fakeIo();
    const writes = vi.fn(io.writeDocument);
    io.writeDocument = writes;
    const store = new AppStore(io);
    await store.openPath("/tmp/conflicted.md");
    store.active!.dirty = true;
    store.active!.conflict = "conflict";
    expect(await store.saveTabById(store.active!.id)).toBe(false);
    expect(writes).not.toHaveBeenCalled();
  });

  it("이름 변경은 미저장 버퍼·실행 취소 상태·잠금·참조 탭을 유지한다", async () => {
    const io = fakeIo();
    io.fileRename = async () => [];
    const store = new AppStore(io);
    await store.openPath("/tmp/before.markdown");
    const tab = store.active!;
    tab.state = tab.state.update({ changes: { from: 0, insert: "unsaved " } }).state;
    tab.dirty = true;
    const editorState = tab.state;
    store.lockedTabIds.add(tab.id);
    store.pinnedTabId = tab.id;
    expect(await store.renameDocument(tab.path!, "/tmp/after.markdown")).toBe(true);
    expect(store.state.tabs).toHaveLength(1);
    expect(store.active).toBe(tab);
    expect(tab.path).toBe("/tmp/after.markdown");
    expect(tab.state).toBe(editorState);
    expect(tab.dirty).toBe(true);
    expect(store.lockedTabIds.has(tab.id)).toBe(true);
    expect(store.pinnedTabId).toBe(tab.id);
    expect(store.buildSession().tabs[0].path).toBe("/tmp/after.markdown");
  });

  it("이름 변경 실패는 원래 경로와 편집 내용을 유지한다", async () => {
    const io = fakeIo();
    io.fileRename = async () => { throw new Error("destination exists"); };
    const store = new AppStore(io);
    await store.openPath("/tmp/original.md");
    const tab = store.active!;
    const before = tab.state;
    expect(await store.renameDocument(tab.path!, "/tmp/existing.md")).toBe(false);
    expect(tab.path).toBe("/tmp/original.md");
    expect(tab.state).toBe(before);
  });

  it("버린 초안은 종료 직전 flush에서 다시 저장하지 않는다", async () => {
    const io = fakeIo();
    const drafts = new Map<string, string>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    io.draftClear = async (key) => { drafts.delete(key); };
    const store = new AppStore(io);
    await store.openPath("/tmp/discard.md");
    store.active!.dirty = true;
    await store.flushDrafts();
    const key = store.active!.draftKey!;
    expect(drafts.has(key)).toBe(true);
    await store.discardDocuments([store.active!.id]);
    await store.flushDrafts();
    expect(drafts.has(key)).toBe(false);
  });
});

describe("종료·초안 복구 실패 처리", () => {
  it("초안 삭제 중 새 입력이 생기면 버림을 중단하고 최신 복구 초안을 다시 쓴다", async () => {
    const io = fakeIo(), drafts = new Map<string, string>();
    let release!: () => void, started!: () => void;
    const deleting = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    io.draftClear = async (key) => { started(); await gate; drafts.delete(key); };
    const store = new AppStore(io), view = mount(store);
    try {
      store.newTabWithContent("original"); const tab = store.active!;
      await store.flushDrafts();
      const result = store.discardDocuments([tab.id]).catch((error: unknown) => error);
      await deleting;
      await expect(store.discardDocuments([tab.id])).rejects.toThrow();
      view.dispatch({ changes: { from: 0, insert: "new " } });
      release();
      expect(await result).toBeInstanceOf(Error);
      expect(tab.dirty).toBe(true);
      expect(drafts.get(tab.draftKey!)).toBe("new original");
    } finally { release(); view.destroy(); setViewListener(null); }
  });

  it("여러 초안 중 뒤쪽 삭제가 실패하면 앞에서 삭제한 초안도 복구한다", async () => {
    const io = fakeIo(), drafts = new Map<string, string>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    const store = new AppStore(io);
    store.newTabWithContent("first"); store.newTabWithContent("second");
    await store.flushDrafts();
    const [first, second] = store.state.tabs;
    io.draftClear = async (key) => {
      drafts.delete(key);
      if (key === second.draftKey) throw new Error("clear interrupted");
    };
    await expect(store.discardDocuments([first.id, second.id])).rejects.toThrow("clear interrupted");
    expect(first.dirty && second.dirty).toBe(true);
    expect(drafts.get(first.draftKey!)).toBe("first");
    expect(drafts.get(second.draftKey!)).toBe("second");
  });

  it("닫기 요청이 취소되면 복구 초안을 지우지 않는다", async () => {
    const io = fakeIo(); io.draftClear = vi.fn(async () => {});
    const store = new AppStore(io); store.newTabWithContent("keep");
    const tab = store.active!;
    await expect(store.discardDocuments([tab.id], () => false)).rejects.toThrow();
    expect(io.draftClear).not.toHaveBeenCalled(); expect(tab.dirty).toBe(true);
  });

  it("종료 직전 초안 쓰기 실패를 호출자에게 전달하고 재시도한다", async () => {
    const io = fakeIo();
    io.draftSave = async () => { throw new Error("disk full"); };
    const store = new AppStore(io);
    store.newTabWithContent("keep my edits");
    await expect(store.flushDrafts()).rejects.toThrow("disk full");
    expect(store.active!.dirty).toBe(true);
    const writes: string[] = [];
    io.draftSave = async (draft) => { writes.push(draft.content); };
    await store.flushDrafts();
    expect(writes).toEqual(["keep my edits"]);
  });

  it("다른 창에서 종료를 취소하면 버린 버퍼의 미저장 표시와 초안을 되살린다", async () => {
    const io = fakeIo();
    const drafts = new Map<string, string>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    io.draftClear = async (key) => { drafts.delete(key); };
    const store = new AppStore(io);
    store.newTabWithContent("still here");
    const tab = store.active!;
    const savedText = tab.savedText;
    await store.flushDrafts();
    await store.discardDocuments([tab.id]);
    expect(drafts.has(tab.draftKey!)).toBe(false);
    store.restoreDiscardedDocuments([tab.id]);
    await store.flushDrafts();
    expect(tab.dirty).toBe(true);
    expect(tab.savedText).toBe(savedText);
    expect(drafts.get(tab.draftKey!)).toBe("still here");
  });

  it("닫기 확인은 진행 중인 본문 저장이 끝나기 전에 진행하지 않는다", async () => {
    const io = fakeIo();
    let finish!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    io.writeDocument = async (_path, text) => {
      signalStarted();
      await new Promise<void>((resolve) => { finish = resolve; });
      return { mtime: 2, size: text.length };
    };
    const store = new AppStore(io);
    store.newTabWithContent("saving now");
    const saving = store.saveDocument(store.active!.id, "/tmp/closing-save.md");
    await started;
    let settled = false;
    const closing = store.settleDocumentWrites().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    expect(await saving).toBe(true);
    await closing;
    expect(settled).toBe(true);
    expect(store.active!.dirty).toBe(false);
  });

  it("초안 버림이 실패하면 미저장 상태를 유지한다", async () => {
    const io = fakeIo();
    io.draftClear = async () => { throw new Error("database locked"); };
    const store = new AppStore(io);
    await store.openPath("/tmp/discard-failed.md");
    const tab = store.active!;
    tab.dirty = true;
    await expect(store.discardDocuments([tab.id])).rejects.toThrow("database locked");
    expect(tab.dirty).toBe(true);
  });

  it("템플릿 새 문서도 미저장 문서로 확인하고 초안을 남긴다", async () => {
    const io = fakeIo();
    const drafts: string[] = [];
    io.draftSave = async (draft) => { drafts.push(draft.content); };
    const store = new AppStore(io);
    store.newTabWithContent("# Template\n");
    expect(store.active!.dirty).toBe(true);
    await store.flushDrafts();
    expect(drafts.at(-1)).toBe("# Template\n");
  });

  it("저장 대화상자에서 탭을 바꿔도 지정한 탭에 저장한다", async () => {
    const io = fakeIo();
    const writes: Array<{ path: string; text: string }> = [];
    io.writeDocument = async (path, text) => {
      writes.push({ path, text });
      return { mtime: 2, size: text.length };
    };
    const store = new AppStore(io);
    store.newTabWithContent("first");
    const firstId = store.active!.id;
    store.newTabWithContent("second");
    const activeId = store.active!.id;
    expect(await store.saveDocument(firstId, "/tmp/first.md")).toBe(true);
    expect(writes).toEqual([{ path: "/tmp/first.md", text: "first" }]);
    expect(store.active!.id).toBe(activeId);
    expect(store.active!.dirty).toBe(true);
  });
});

const recoverySession = (tabs: import("../api").SessionTab[], active: string | null = null): import("../api").SessionState => ({
  version: 1, tabs, active, workspace: null, sidebarOpen: false,
  sidebarWidth: 240, tocOpen: true, window: null,
});

const sessionTab = (path: string | null, draftKey?: string): import("../api").SessionTab => ({
  path, draftKey, mode: "edit", cursor: 0, scroll: 0,
});

describe("복구 데이터 보존과 세션 정체성", () => {
  it("파일을 읽지 못해도 초안 내용과 원문 메타를 복원한다", async () => {
    const io = fakeIo();
    io.readDocument = async () => { throw new Error("offline volume"); };
    io.draftLoad = async (key) => ({
      key, path: key, content: "작성 중인 문서", cursor: 500, scroll: 7, updatedAt: 1,
      baseText: "기준", meta: { hadBom: true, crlf: true },
    });
    const store = new AppStore(io);
    await store.restoreSession(recoverySession([sessionTab("/volume/a.md")], "/volume/a.md"));
    expect(store.active!.state.doc.toString()).toBe("작성 중인 문서");
    expect(store.active!.meta).toEqual({ hadBom: true, crlf: true });
    expect(store.active!.conflict).toBe("removed");
    expect(store.active!.dirty).toBe(true);
    expect(store.active!.state.selection.main.head).toBe(store.active!.state.doc.length);
    expect(await store.saveTabById(store.active!.id)).toBe(false);
  });

  it("파일·제목 없는 탭의 순서와 활성 초안, 빈 초안을 보존한다", async () => {
    const io = fakeIo();
    io.draftLoad = async (key) => key.startsWith("untitled:")
      ? { key, path: null, content: "", cursor: 0, scroll: 0, updatedAt: 1 } : null;
    const store = new AppStore(io);
    const session = recoverySession([
      sessionTab("/a.md"), sessionTab(null, "untitled:empty"), sessionTab("/b.md"),
    ], "untitled:empty");
    await store.restoreSession(session);
    expect(store.buildSession().tabs.map((tab) => tab.path ?? tab.draftKey))
      .toEqual(["/a.md", "untitled:empty", "/b.md"]);
    expect(store.active!.draftKey).toBe("untitled:empty");
    expect(store.active!.dirty).toBe(true);
    expect(store.buildSession().active).toBe("untitled:empty");
    expect(store.state.sidebarOpen).toBe(false);
  });

  it("세션 JSON에 기록되지 못한 초안도 목록에서 발견한다", async () => {
    const io = fakeIo();
    io.draftList = async () => [{ key: "untitled:orphan", path: null, updatedAt: 1 }];
    io.draftLoad = async (key) => ({ key, path: null, content: "남아야 하는 글", cursor: 0, scroll: 0, updatedAt: 1 });
    const store = new AppStore(io);
    await store.restoreSession(recoverySession([]));
    expect(store.active!.state.doc.toString()).toBe("남아야 하는 글");
    await store.retryRecovery();
    expect(store.state.tabs).toHaveLength(1);
  });

  it("초안 읽기 실패를 없음으로 간주하지 않고 재시도할 정보를 남긴다", async () => {
    const io = fakeIo();
    io.draftLoad = async () => { throw new Error("locked draft database"); };
    const store = new AppStore(io);
    await store.restoreSession(recoverySession([sessionTab("/a.md")]));
    expect(store.state.tabs).toHaveLength(0);
    expect(store.buildSession().tabs[0].path).toBe("/a.md");
    io.draftLoad = async () => null;
    await store.retryRecovery();
    expect(store.state.tabs).toHaveLength(1);
    expect(store.buildSession().tabs).toHaveLength(1);
  });

  it("재시작 전에 디스크가 달라졌으면 복원 초안의 자동 저장을 막는다", async () => {
    const io = fakeIo();
    io.draftLoad = async (key) => ({
      key, path: key, content: "my edit", baseText: "older disk", cursor: 0, scroll: 0, updatedAt: 1,
    });
    const store = new AppStore(io);
    await store.restoreSession(recoverySession([sessionTab("/conflict.md")]));
    expect(store.active!.conflict).toBe("conflict");
    expect(await store.saveTabById(store.active!.id)).toBe(false);
  });

  it("이미 디스크와 같은 초안은 수정된 문서로 표시하지 않는다", async () => {
    const io = fakeIo();
    io.draftLoad = async (key) => ({
      key, path: key, content: (await io.readDocument(key)).text, cursor: 0, scroll: 0, updatedAt: 1,
    });
    const store = new AppStore(io);
    await store.restoreSession(recoverySession([sessionTab("/saved.md")]));
    expect(store.active!.dirty).toBe(false);
    expect(store.active!.conflict).toBeNull();
  });

  it("복원에서도 스타일·책갈피·메모·추적 기준선을 읽는다", async () => {
    const io = fakeIo();
    io.docStyleGet = async () => JSON.stringify({ fontSize: 19 });
    io.bookmarkList = async (path) => ({ lines: [2], text: (await io.readDocument(path)).text, revision: 1 });
    io.commentList = async () => [{ id: 1, lineNo: 2, text: "memo", createdAt: 1, resolved: false }];
    io.baselineGet = async () => ({ text: "baseline", revision: 1 });
    const store = new AppStore(io);
    await store.restoreSession(recoverySession([sessionTab("/styled.md")]));
    expect(store.active!.docStyle!.fontSize).toBe(19);
    expect(store.active!.bookmarks).toEqual([2]);
    expect(store.active!.comments[0].text).toBe("memo");
    expect(store.active!.baselineText).toBe("baseline");
  });
});

describe("늦은 파일 읽기 응답 보호", () => {
  it("새 파일 작업은 이전 열기의 늦은 활성화를 막지만 더 최신 탐색에는 양보한다", async () => {
    const io = fakeIo(), store = new AppStore(io);
    await store.openPath("/original.md"); const original = store.active;
    const read = io.readDocument; let finish!: () => void;
    io.readDocument = (path) => new Promise((resolve) => { finish = () => { void read(path).then(resolve); }; });
    const earlier = store.openPath("/earlier.md");
    const action = store.beginWorkspaceFileAction();
    finish(); await earlier;
    expect(store.active).toBe(original); expect(action.canNavigate()).toBe(true);
    store.newTabWithContent("latest intent"); expect(action.canNavigate()).toBe(false);
  });

  it("같은 워크스페이스를 닫았다 다시 열어도 이전 파일 작업의 탐색은 무효다", async () => {
    const store = new AppStore(fakeIo()); await store.openWorkspace("/w");
    const action = store.beginWorkspaceFileAction();
    store.closeWorkspace(); await store.openWorkspace("/w");
    expect(store.state.workspace).toBe("/w"); expect(action.isWorkspaceCurrent()).toBe(false);
    expect(action.canNavigate()).toBe(false);
  });

  it.each(["edit", "selection"])("파일 작업 중 %s 변경은 편집 위치를 유지한다", async (change) => {
    const store = new AppStore(fakeIo()), view = mount(store);
    try {
      await openTab(store, "/original.md");
      const action = store.beginWorkspaceFileAction();
      if (change === "edit") view.dispatch({ changes: { from: 0, insert: "new input " } });
      else view.dispatch({ selection: { anchor: 1 } });
      expect(action.isWorkspaceCurrent()).toBe(true); expect(action.canNavigate()).toBe(false);
    } finally { view.destroy(); setViewListener(null); }
  });

  it("생성된 파일을 읽는 중 워크스페이스가 바뀌면 읽기 완료가 활성 문서를 바꾸지 않는다", async () => {
    const io = fakeIo(), store = new AppStore(io);
    await store.openWorkspace("/w"); await store.openPath("/original.md"); const original = store.active;
    const action = store.beginWorkspaceFileAction();
    const read = io.readDocument; let finish!: () => void;
    io.readDocument = (path) => new Promise((resolve) => { finish = () => { void read(path).then(resolve); }; });
    const opening = store.openPath("/w/new.md", undefined, undefined, action.isWorkspaceCurrent);
    await store.openWorkspace("/other"); finish(); await opening;
    expect(store.active).toBe(original); expect(store.state.workspace).toBe("/other");
    expect(store.state.tabs.some((tab) => tab.path === "/w/new.md")).toBe(true);
  });

  it("이전 저장을 기다리던 다른 이름 저장은 철회된 요청을 쓰지 않는다", async () => {
    const io = fakeIo();
    let finish!: () => void;
    const write = vi.fn(async (_path: string, text: string) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { mtime: 2, size: text.length };
    });
    io.writeDocument = write;
    const store = new AppStore(io); await store.openPath("/original.md");
    const tab = store.active!;
    tab.state = tab.state.update({ changes: { from: 0, insert: "mine " } }).state;
    tab.dirty = true;
    const first = store.saveDocument(tab.id);
    let current = true;
    const copy = store.saveDocument(tab.id, "/copy.md", () => current);
    current = false; finish();
    expect(await first).toBe(true); expect(await copy).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toBe("/original.md");
    expect(tab.path).toBe("/original.md");
  });

  it("다른 이름 저장이 문서 정보를 기다리는 동안 변경된 본문을 쓰지 않는다", async () => {
    const io = fakeIo(); let finish!: () => void;
    io.docStyleGet = () => new Promise((resolve) => { finish = () => resolve(null); });
    const write = vi.fn(io.writeDocument); io.writeDocument = write;
    const store = new AppStore(io); await store.openPath("/original.md");
    const tab = store.active!, original = tab.state.doc;
    const saving = store.saveDocument(tab.id, "/copy.md", () => tab.state.doc === original);
    tab.state = tab.state.update({ changes: { from: 0, insert: "later input " } }).state;
    tab.dirty = true; finish();
    expect(await saving).toBe(false); expect(write).not.toHaveBeenCalled();
    expect(tab.path).toBe("/original.md"); expect(tab.dirty).toBe(true);
    expect(tab.state.doc.toString()).toContain("later input");
  });

  it("디스크에서 삭제된 깨끗한 문서도 열린 버퍼를 복구 초안으로 보관한다", async () => {
    const io = fakeIo(), drafts = new Map<string, string>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft.content); };
    const store = new AppStore(io); await store.openPath("/removed.md");
    const tab = store.active!, text = tab.state.doc.toString();
    expect(tab.dirty).toBe(false);
    store.externalChange(tab.path!, "removed");
    await store.flushDrafts();
    expect(tab.dirty).toBe(true); expect(tab.conflict).toBe("removed");
    expect(drafts.get(tab.draftKey!)).toBe(text);
  });

  it("미저장 본문은 필수 백업 후 최신 디스크 버전으로 다시 읽는다", async () => {
    const io = fakeIo(); let text = "baseline";
    io.readDocument = async () => ({ text, meta: { hadBom: false, crlf: false }, mtime: 1, size: text.length });
    const store = new AppStore(io);
    await store.openPath("/reload.md");
    const tab = store.active!;
    tab.state = tab.state.update({ changes: { from: 0, insert: "mine " } }).state;
    tab.dirty = true; tab.conflict = "conflict"; text = "disk before backup";
    io.snapshotBackup = vi.fn(async () => { text = "disk after backup"; });
    expect(await store.reloadTab(tab.id, true)).toEqual({ status: "applied" });
    expect(io.snapshotBackup).toHaveBeenCalledWith("/reload.md", "mine baseline");
    expect(tab.state.doc.toString()).toBe("disk after backup");
    expect(tab.savedText).toBe("disk after backup");
    expect(tab.dirty).toBe(false); expect(tab.conflict).toBeNull();
  });

  it("백업 실패는 원문·미저장·충돌을 유지하고 재시도 결과를 반환한다", async () => {
    const io = fakeIo(), store = new AppStore(io);
    await store.openPath("/reload.md"); const tab = store.active!;
    tab.state = tab.state.update({ changes: { from: 0, insert: "mine " } }).state;
    tab.dirty = true; tab.conflict = "conflict";
    const original = tab.state.doc;
    io.snapshotBackup = async () => { throw new Error("backup full"); };
    expect(await store.reloadTab(tab.id, true)).toEqual({ status: "failed", message: "backup full" });
    expect(tab.state.doc).toBe(original); expect(tab.dirty).toBe(true); expect(tab.conflict).toBe("conflict");
  });

  it.each(["edit", "cancel", "removed"])("백업 중 %s 변경은 늦은 다시 읽기를 적용하지 않는다", async (cause) => {
    const io = fakeIo(), store = new AppStore(io);
    await store.openPath("/reload.md"); const tab = store.active!;
    tab.state = tab.state.update({ changes: { from: 0, insert: "mine " } }).state;
    tab.dirty = true; tab.conflict = "conflict";
    let release!: () => void, started!: () => void, current = true;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    io.snapshotBackup = async () => { started(); await new Promise<void>((resolve) => { release = resolve; }); };
    const operation = store.reloadTab(tab.id, true, () => current);
    await ready;
    if (cause === "edit") tab.state = tab.state.update({ changes: { from: 0, insert: "new " } }).state;
    else if (cause === "cancel") current = false;
    else store.externalChange(tab.path!, "removed");
    const latest = tab.state.doc;
    release(); expect(await operation).toEqual({ status: "changed" });
    expect(tab.state.doc).toBe(latest); expect(tab.dirty).toBe(true);
    expect(tab.conflict).toBe(cause === "removed" ? "removed" : "conflict");
  });

  it("내 버전 유지의 확인이 취소되면 늦은 디스크 읽기로 덮어쓰기를 승인하지 않는다", async () => {
    const io = fakeIo(), store = new AppStore(io);
    await store.openPath("/keep.md"); const tab = store.active!;
    tab.dirty = true; tab.conflict = "conflict";
    let release!: () => void, current = true;
    const disk = await io.readDocument(tab.path!);
    io.readDocument = () => new Promise((resolve) => { release = () => resolve(disk); });
    const operation = store.keepMine(tab.id, () => current);
    current = false; release();
    expect(await operation).toEqual({ status: "changed" });
    expect(tab.conflict).toBe("conflict");
  });

  it("이미 dirty인 문서도 다시 읽기 요청 이후 입력은 버리지 않는다", async () => {
    const io = fakeIo();
    const store = new AppStore(io);
    await store.openPath("/tmp/reload.md");
    const tab = store.active!;
    tab.dirty = true;
    const disk = await io.readDocument(tab.path!);
    let finish!: () => void;
    io.readDocument = async () => new Promise((resolve) => { finish = () => resolve(disk); });
    const reading = store.reloadTab(tab.id, true);
    tab.state = tab.state.update({ changes: { from: 0, insert: "typed later " } }).state;
    const latest = tab.state.doc.toString();
    finish();
    await reading;
    expect(tab.state.doc.toString()).toBe(latest);
    expect(tab.conflict).toBe("conflict");
  });

  it("워크스페이스 전환 후 옛 폴더의 늦은 트리를 적용하지 않는다", async () => {
    const io = fakeIo();
    let finish!: () => void;
    io.scanWorkspace = async (root) => root === "/old"
      ? new Promise((resolve) => { finish = () => resolve({ tree: [{ kind: "file", name: "old.md", path: "/old/old.md" }], issues: [] }); })
      : { tree: [{ kind: "file", name: "new.md", path: "/new/new.md" }], issues: [] };
    const store = new AppStore(io);
    const first = store.openWorkspace("/old");
    await Promise.resolve();
    const second = store.openWorkspace("/new");
    finish();
    await Promise.all([first, second]);
    expect(store.state.workspace).toBe("/new");
    expect(store.state.tree[0].path).toBe("/new/new.md");
  });
});


const styleWithSize = (fontSize: number) => ({ ...DEFAULT_DOC_STYLE, fontSize });

describe("디스크 기준 확인과 창 간 저장 충돌", () => {
  function sharedDisk() {
    const io = fakeIo();
    let text: string | null = "baseline";
    const meta = { hadBom: false, crlf: false };
    io.readDocument = async () => {
      if (text === null) throw new Error("missing");
      return { text, meta, mtime: 1, size: text.length };
    };
    io.writeDocument = async (_path, next, _meta, expected) => {
      if ((expected.kind === "missing" && text !== null) ||
        (expected.kind === "match" && expected.text !== text)) {
        throw { code: text === null ? "removed" : "conflict", message: "changed on disk" };
      }
      text = next;
      return { mtime: 2, size: next.length };
    };
    return { io, get: () => text, change: (next: string | null) => { text = next; } };
  }

  it("감시 알림이 없어도 두 번째 창의 오래된 저장을 거부하고 입력을 유지한다", async () => {
    const disk = sharedDisk();
    const first = new AppStore(disk.io);
    const second = new AppStore(disk.io);
    await first.openPath("/shared.md");
    await second.openPath("/shared.md");
    for (const [store, prefix] of [[first, "first "], [second, "second "]] as const) {
      const tab = store.active!;
      tab.state = tab.state.update({ changes: { from: 0, insert: prefix } }).state;
      tab.dirty = true;
    }
    expect(await first.saveActive()).toBe(true);
    expect(await second.saveActive()).toBe(false);
    expect(disk.get()).toBe("first baseline");
    expect(second.active!.state.doc.toString()).toBe("second baseline");
    expect(second.active!.savedText).toBe("baseline");
    expect(second.active!.dirty).toBe(true);
    expect(second.active!.conflict).toBe("conflict");
  });

  it("내 버전 유지 뒤 추가 변경은 다시 확인하고 자동 저장으로 승인하지 않는다", async () => {
    const disk = sharedDisk();
    const store = new AppStore(disk.io);
    await store.openPath("/shared.md");
    const tab = store.active!;
    tab.state = tab.state.update({ changes: { from: 0, insert: "mine " } }).state;
    tab.dirty = true;
    disk.change("other window");
    expect(await store.saveActive()).toBe(false);
    await store.keepMine(tab.id);
    expect(await store.saveTabById(tab.id)).toBe(false);
    expect(disk.get()).toBe("other window");
    disk.change("changed again");
    expect(await store.saveActive()).toBe(false);
    expect(tab.conflict).toBe("conflict");
    await store.keepMine(tab.id);
    expect(await store.saveActive()).toBe(true);
    expect(disk.get()).toBe("mine baseline");
  });

  it("삭제된 문서는 재생성 선택 후에도 같은 경로에 생긴 다른 파일을 보존한다", async () => {
    const disk = sharedDisk();
    const store = new AppStore(disk.io);
    await store.openPath("/shared.md");
    const tab = store.active!;
    tab.dirty = true;
    disk.change(null);
    expect(await store.saveActive()).toBe(false);
    expect(tab.conflict).toBe("removed");
    await store.keepMine(tab.id);
    disk.change("new file");
    expect(await store.saveActive()).toBe(false);
    expect(disk.get()).toBe("new file");
    expect(await store.createNote("/shared.md")).toBe(false);
    expect(disk.get()).toBe("new file");
  });
});

describe("창·탭별 복구 초안 정체성", () => {
  function recoveryIo() {
    const io = fakeIo();
    const drafts = new Map<string, import("../api").Draft>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft); };
    io.draftClear = async (key) => { drafts.delete(key); };
    io.draftLoad = async (key) => drafts.get(key) ?? null;
    io.draftList = async () => [...drafts.values()].map(({ key, path, updatedAt }) => ({ key, path, updatedAt }));
    return { io, drafts };
  }

  it("한 창의 저장·닫기가 다른 창의 같은 파일 초안을 지우지 않는다", async () => {
    const { io, drafts } = recoveryIo();
    const first = new AppStore(io);
    const second = new AppStore(io);
    await first.openPath("/shared-draft.md");
    await second.openPath("/shared-draft.md");
    const firstKey = first.active!.draftKey!;
    const secondKey = second.active!.draftKey!;
    expect(firstKey).not.toBe(secondKey);
    for (const [store, prefix] of [[first, "first "], [second, "second "]] as const) {
      const tab = store.active!;
      tab.state = tab.state.update({ changes: { from: 0, insert: prefix } }).state;
      tab.dirty = true;
      await store.flushDrafts();
    }
    expect(drafts.size).toBe(2);
    expect(await first.saveActive()).toBe(true);
    expect(first.active!.draftKey).toBe(firstKey);
    expect(drafts.has(firstKey)).toBe(false);
    expect(drafts.get(secondKey)!.content).toContain("second ");
    first.closeTab(first.active!.id);
    await first.flushDrafts();
    expect(drafts.has(secondKey)).toBe(true);
  });

  it("같은 경로의 복구본을 모두 열고 활성·잠금·참조 탭을 키로 구분한다", async () => {
    const { io, drafts } = recoveryIo();
    for (const [key, content] of [["document:one", "one"], ["document:two", "two"]]) {
      drafts.set(key, { key, path: "/shared.md", content, cursor: 0, scroll: 0, updatedAt: 1 });
    }
    const store = new AppStore(io);
    const session = recoverySession([
      sessionTab("/shared.md", "document:one"), sessionTab("/shared.md", "document:two"),
    ], "document:two");
    session.lockedPaths = ["document:one"];
    session.pinnedPath = "document:two";
    await store.restoreSession(session);
    expect(store.state.tabs.map((tab) => tab.state.doc.toString())).toEqual(["one", "two"]);
    expect(store.active!.draftKey).toBe("document:two");
    expect(store.lockedTabIds.has(store.state.tabs[0].id)).toBe(true);
    expect(store.pinnedTabId).toBe(store.state.tabs[1].id);
    expect(store.buildSession().active).toBe("document:two");
    await store.retryRecovery();
    expect(store.state.tabs).toHaveLength(2);
    expect(await store.saveActive()).toBe(true);
    expect(drafts.has("document:two")).toBe(false);
    expect(drafts.has("document:one")).toBe(true);
  });

  it("다른 이름으로 저장한 뒤에도 키를 유지하고 초안의 최신 경로로 복원한다", async () => {
    const { io, drafts } = recoveryIo();
    const store = new AppStore(io);
    store.newTabWithContent("draft");
    const key = store.active!.draftKey!;
    const stale = store.buildSession();
    expect(await store.saveActive("/saved.md")).toBe(true);
    expect(store.active!.draftKey).toBe(key);
    store.active!.dirty = true;
    await store.flushDrafts();
    expect(drafts.get(key)!.path).toBe("/saved.md");
    const restored = new AppStore(io);
    await restored.restoreSession(stale);
    expect(restored.active!.path).toBe("/saved.md");
    expect(restored.active!.draftKey).toBe(key);
    expect(restored.state.tabs).toHaveLength(1);
  });
});

describe("문서별 스타일 저장 수명주기", () => {
  it("디바운스 중 탭을 전환해도 각 문서에 해당 스타일을 저장한다", async () => {
    vi.useFakeTimers();
    try {
      const io = fakeIo();
      const styles = new Map<string, number>();
      io.docStyleSet = async (path, json) => { styles.set(path, JSON.parse(json).fontSize); };
      const store = new AppStore(io);
      await store.openPath("/first.md");
      store.setDocStyle(styleWithSize(18));
      await store.openPath("/second.md");
      store.setDocStyle(styleWithSize(24));
      await vi.advanceTimersByTimeAsync(400);
      expect(styles.get("/first.md")).toBe(18);
      expect(styles.get("/second.md")).toBe(24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("저장 응답을 기다리는 동안 변경한 스타일은 순서대로 마지막 값까지 저장한다", async () => {
    const io = fakeIo();
    let finish!: () => void;
    const writes: number[] = [];
    io.docStyleSet = async (_path, json) => {
      writes.push(JSON.parse(json).fontSize);
      if (writes.length === 1) await new Promise<void>((resolve) => { finish = resolve; });
    };
    const store = new AppStore(io);
    await store.openPath("/style.md");
    store.setDocStyle(styleWithSize(18));
    const saving = store.flushDocStyles();
    store.setDocStyle(styleWithSize(26));
    expect(writes).toEqual([18]);
    finish();
    expect(await saving).toBe(true);
    expect(writes).toEqual([18, 26]);
  });

  it("스타일 저장 실패는 종료를 막고 본문 재쓰기 없이 재시도한다", async () => {
    const io = fakeIo();
    const writeBody = vi.fn(io.writeDocument);
    io.writeDocument = writeBody;
    io.docStyleSet = async () => { throw new Error("disk full"); };
    const store = new AppStore(io);
    await store.openPath("/retry-style.md");
    store.setDocStyle(styleWithSize(19));
    await expect(store.flushDrafts()).rejects.toThrow();
    expect(store.active!.docStyle!.fontSize).toBe(19);
    const styleWrites: string[] = [];
    io.docStyleSet = async (_path, json) => { styleWrites.push(json); };
    expect(await store.saveActive()).toBe(true);
    expect(JSON.parse(styleWrites[0]).fontSize).toBe(19);
    expect(writeBody).not.toHaveBeenCalled();
  });

  it("제목 없는 빈 문서의 스타일을 복구 키에 저장하고 다시 복원한다", async () => {
    const io = fakeIo();
    const drafts = new Map<string, import("../api").Draft>();
    const styles = new Map<string, string>();
    io.draftSave = async (draft) => { drafts.set(draft.key, draft); };
    io.draftLoad = async (key) => drafts.get(key) ?? null;
    io.docStyleSet = async (key, json) => { styles.set(key, json); };
    io.docStyleGet = async (key) => styles.get(key) ?? null;
    const store = new AppStore(io);
    store.newTab();
    store.setDocStyle(styleWithSize(23));
    await store.flushDrafts();
    const session = store.buildSession();
    const key = session.tabs[0].draftKey!;
    expect(drafts.get(key)!.content).toBe("");
    const restored = new AppStore(io);
    await restored.restoreSession(session);
    expect(restored.active!.docStyle!.fontSize).toBe(23);
  });

  it("다른 이름으로 저장은 늦게 조회된 원본 스타일도 새 경로에 복사한다", async () => {
    const io = fakeIo();
    let finish!: () => void;
    const styles = new Map<string, string>();
    io.docStyleGet = async () => new Promise((resolve) => {
      finish = () => resolve(JSON.stringify(styleWithSize(21)));
    });
    io.docStyleSet = async (path, json) => { styles.set(path, json); };
    const store = new AppStore(io);
    await store.openPath("/original.md");
    const saving = store.saveActive("/copy.md");
    expect(styles.size).toBe(0);
    finish();
    expect(await saving).toBe(true);
    expect(JSON.parse(styles.get("/copy.md")!).fontSize).toBe(21);
  });

  it("이름 변경 전 스타일 쓰기를 끝내고 변경 중의 새 스타일은 새 경로에 쓴다", async () => {
    const io = fakeIo();
    const operations: string[] = [];
    const store = new AppStore(io);
    io.docStyleSet = async (path, json) => { operations.push(`${path}:${JSON.parse(json).fontSize}`); };
    io.fileRename = async () => {
      operations.push("rename");
      store.setDocStyle(styleWithSize(28));
      return [];
    };
    await store.openPath("/before.md");
    store.setDocStyle(styleWithSize(18));
    expect(await store.renameDocument("/before.md", "/after.md")).toBe(true);
    expect(operations).toEqual(["/before.md:18", "rename", "/after.md:28"]);
  });

  it("닫은 탭의 대기 스타일도 종료 전 저장에 포함한다", async () => {
    const io = fakeIo();
    const styles = new Map<string, string>();
    io.docStyleSet = async (path, json) => { styles.set(path, json); };
    const store = new AppStore(io);
    await store.openPath("/closing.md");
    store.setDocStyle(styleWithSize(17));
    store.closeTab(store.active!.id);
    await store.flushDrafts();
    expect(JSON.parse(styles.get("/closing.md")!).fontSize).toBe(17);
  });
});

describe("버전 복원 전 보존", () => {
  it("미저장 버퍼를 백업한 다음 복원하고 디스크 기준은 유지한다", async () => {
    const io = fakeIo();
    const backup = vi.fn(async () => {});
    io.snapshotBackup = backup;
    io.writeDocument = vi.fn(io.writeDocument);
    const store = new AppStore(io);
    store.state.settings.autosave = false;
    const view = mount(store);
    try {
      await openTab(store, "/restore.md");
      const saved = store.active!.savedText;
      view.dispatch({ changes: { from: 0, insert: "미저장 내용\n" } });
      const before = view.state.doc;
      await store.restoreVersion(store.active!.id, "/restore.md", before, "이전 버전");
      expect(backup).toHaveBeenCalledWith("/restore.md", before.toString());
      expect(view.state.doc.toString()).toBe("이전 버전");
      expect(store.active!.savedText).toBe(saved);
      expect(store.active!.dirty).toBe(true);
      expect(io.writeDocument).not.toHaveBeenCalled();
      let undone = "";
      expect(undo({ state: view.state, dispatch: (transaction) => {
        undone = transaction.state.doc.toString();
      } })).toBe(true);
      expect(undone).toBe(before.toString());
    } finally {
      view.destroy();
      store.view = null;
      setViewListener(null);
    }
  });

  it("백업 실패 시 본문을 교체하지 않는다", async () => {
    const io = fakeIo();
    io.snapshotBackup = async () => { throw new Error("disk full"); };
    const store = new AppStore(io);
    store.state.settings.autosave = false;
    const view = mount(store);
    try {
      await openTab(store, "/restore.md");
      const before = view.state.doc;
      await expect(store.restoreVersion(store.active!.id, "/restore.md", before, "old"))
        .rejects.toThrow("disk full");
      expect(view.state.doc).toBe(before);
      expect(store.active!.dirty).toBe(false);
    } finally {
      view.destroy();
      store.view = null;
      setViewListener(null);
    }
  });

  it.each(["edit", "switch", "lock"])("백업 대기 중 %s 발생 시 복원을 중단한다", async (change) => {
    const io = fakeIo();
    let finish!: () => void;
    io.snapshotBackup = () => new Promise<void>((resolve) => { finish = resolve; });
    const store = new AppStore(io);
    store.state.settings.autosave = false;
    const view = mount(store);
    try {
      await openTab(store, "/other.md");
      const other = store.active!;
      await openTab(store, "/restore.md");
      const target = store.active!;
      const restoring = store.restoreVersion(target.id, "/restore.md", view.state.doc, "old");
      const rejected = expect(restoring).rejects.toThrow();
      if (change === "edit") view.dispatch({ changes: { from: 0, insert: "latest" } });
      else if (change === "switch") store.activate(other.id);
      else store.lockedTabIds.add(target.id);
      const current = view.state.doc;
      finish();
      await rejected;
      expect(view.state.doc).toBe(current);
      expect(target.state.doc.toString()).not.toBe("old");
    } finally {
      view.destroy();
      store.view = null;
      setViewListener(null);
    }
  });
});

describe("최근 문서 동기화", () => {
  it("늦은 조회 응답이 새 변경 이벤트를 되돌리지 않는다", async () => {
    const io = fakeIo();
    let resolve!: (value: { revision: number; entries: Array<{ path: string; name: string }> }) => void;
    io.getRecent = () => new Promise((done) => { resolve = done; });
    const store = new AppStore(io);
    const loading = store.loadRecent();
    store.acceptRecent({ revision: 4, entries: [] });
    resolve({ revision: 3, entries: [{ path: "/old.md", name: "old.md" }] });
    await loading;
    expect(store.state.recent).toEqual([]);
    expect(store.state.recentLoading).toBe(false);
  });

  it("목록 비우기 실패 시 기존 항목을 유지한다", async () => {
    const io = fakeIo();
    io.clearRecent = async () => { throw new Error("disk full"); };
    const store = new AppStore(io);
    store.acceptRecent({ revision: 2, entries: [{ path: "/a.md", name: "a.md" }] });
    expect(await store.clearRecent()).toBe(false);
    expect(store.state.recent[0].path).toBe("/a.md");
    expect(store.state.recentError).toContain("disk full");
    expect(store.state.recentBusy).toBe(false);
  });

  it("기록 요청 뒤 목록 비우기를 순서대로 실행한다", async () => {
    const io = fakeIo();
    let finish!: () => void;
    io.recordRecent = () => new Promise((resolve) => {
      finish = () => resolve({ revision: 1, entries: [{ path: "/a.md", name: "a.md" }] });
    });
    io.clearRecent = vi.fn(async () => ({ revision: 2, entries: [] }));
    const store = new AppStore(io);
    const recording = store.recordRecent("/a.md");
    await Promise.resolve();
    const clearing = store.clearRecent();
    expect(io.clearRecent).not.toHaveBeenCalled();
    finish();
    await recording;
    await clearing;
    expect(io.clearRecent).toHaveBeenCalledTimes(1);
    expect(store.state.recent).toEqual([]);
  });

  it("열려 있는 문서를 다시 열어도 최근 기록을 갱신하고 자동 저장은 순서를 바꾸지 않는다", async () => {
    const io = fakeIo();
    io.recordRecent = vi.fn(async (path: string) => ({ revision: 1, entries: [{ path, name: "a.md" }] }));
    const store = new AppStore(io);
    await store.openPath("/a.md");
    await store.settleDocumentWrites();
    await store.openPath("/a.md");
    await store.settleDocumentWrites();
    expect(io.recordRecent).toHaveBeenCalledTimes(2);
    const tab = store.active!;
    tab.state = tab.state.update({ changes: { from: 0, insert: "edit" } }).state;
    tab.dirty = true;
    await store.saveTabById(tab.id);
    await store.settleDocumentWrites();
    expect(io.recordRecent).toHaveBeenCalledTimes(2);
  });
});

describe("워크스페이스 로딩과 부분 결과", () => {
  it("정상적으로 읽은 최신 폴더만 기록하고 실패한 폴더는 기록하지 않는다", async () => {
    const io = fakeIo();
    io.updateWorkspaceHistory = vi.fn(async () => ({ revision: 1, entries: [] }));
    let finish!: () => void;
    io.scanWorkspace = (root) => root === "/slow" ? new Promise((resolve) => { finish = () => resolve({ tree: [], issues: [] }); })
      : root === "/failed" ? Promise.reject(new Error("offline")) : Promise.resolve({ tree: [], issues: [] });
    const store = new AppStore(io);
    const first = store.openWorkspace("/slow"); await Promise.resolve();
    const second = store.openWorkspace("/current"); finish(); await Promise.all([first, second]); await Promise.resolve();
    expect(io.updateWorkspaceHistory).toHaveBeenCalledTimes(1);
    expect(io.updateWorkspaceHistory).toHaveBeenCalledWith({ kind: "record", path: "/current" });
    await store.openWorkspace("/failed"); await Promise.resolve();
    expect(io.updateWorkspaceHistory).toHaveBeenCalledTimes(1);
  });

  it("폴더 전환·기록 제거가 열린 문서와 미저장 내용을 바꾸지 않는다", async () => {
    const io = fakeIo(); io.updateWorkspaceHistory = async () => ({ revision: 1, entries: [] });
    const store = new AppStore(io); store.newTabWithContent("unsaved draft"); const tab = store.active!;
    await store.openWorkspace("/a"); await store.openWorkspace("/b"); await store.workspaceHistory.clear(); store.closeWorkspace();
    expect(store.active).toBe(tab); expect(tab.state.doc.toString()).toBe("unsaved draft"); expect(tab.dirty).toBe(true);
  });

  it("새 폴더 스캔 전 이전 폴더의 트리와 인덱스를 비운다", async () => {
    const io = fakeIo();
    let finish!: () => void;
    io.scanWorkspace = async (root) => root === "/a"
      ? { tree: [{ kind: "file", name: "a.md", stem: "a", path: "/a/a.md" }], issues: [] }
      : new Promise((resolve) => { finish = () => resolve({ tree: [], issues: [] }); });
    const store = new AppStore(io);
    await store.openWorkspace("/a");
    const opening = store.openWorkspace("/b");
    expect(store.state.workspace).toBe("/b");
    expect(store.state.workspaceLoading).toBe(true);
    expect(store.state.tree).toEqual([]);
    expect(store.wikiIndex.size).toBe(0);
    await Promise.resolve();
    finish();
    await opening;
    expect(store.state.workspaceLoading).toBe(false);
    expect(store.state.workspaceTreeLoaded).toBe(true);
  });

  it("같은 폴더 재조회 실패는 기존 트리를 보존하고 재시도로 해소된다", async () => {
    const io = fakeIo();
    const tree = [{ kind: "file" as const, name: "a.md", path: "/a/a.md" }];
    io.scanWorkspace = async () => ({ tree, issues: [] });
    const store = new AppStore(io);
    await store.openWorkspace("/a");
    io.scanWorkspace = async () => { throw new Error("unavailable"); };
    await store.refreshTree();
    expect(store.state.tree).toBe(tree);
    expect(store.state.workspaceError).toContain("unavailable");
    expect(store.state.workspaceLoading).toBe(false);
    io.scanWorkspace = async () => ({ tree: [], issues: [] });
    await store.openWorkspace("/a");
    expect(store.state.workspaceError).toBeNull();
    expect(store.state.tree).toEqual([]);
  });

  it("부분 조회 문제를 버리지 않고 트리와 함께 보관한다", async () => {
    const io = fakeIo();
    const issues = [{ path: "/a/private", code: "read" as const, message: "denied" }];
    io.scanWorkspace = async () => ({ tree: [{ kind: "dir", name: "private", path: "/a/private", children: [] }], issues });
    const store = new AppStore(io);
    await store.openWorkspace("/a");
    expect(store.state.workspaceIssues).toBe(issues);
    expect(store.state.workspaceTreeLoaded).toBe(true);
    expect(store.state.workspaceError).toBeNull();
  });

  it("A→B→A 전환 중 첫 A의 결과를 새 A에 적용하지 않는다", async () => {
    const io = fakeIo();
    let oldFinish!: () => void;
    let newFinish!: () => void;
    let signal!: () => void;
    const newStarted = new Promise<void>((resolve) => { signal = resolve; });
    let count = 0;
    io.scanWorkspace = () => new Promise((resolve) => {
      if (++count === 1) oldFinish = () => resolve({ tree: [{ kind: "file", name: "old.md", path: "/a/old.md" }], issues: [] });
      else { newFinish = () => resolve({ tree: [], issues: [] }); signal(); }
    });
    const store = new AppStore(io);
    const first = store.openWorkspace("/a");
    await Promise.resolve();
    const second = store.openWorkspace("/b");
    const third = store.openWorkspace("/a");
    oldFinish();
    await newStarted;
    expect(store.state.tree).toEqual([]);
    expect(store.state.workspaceLoading).toBe(true);
    newFinish();
    await Promise.all([first, second, third]);
    expect(store.state.workspace).toBe("/a");
    expect(store.state.tree).toEqual([]);
  });

  it("조회 중 폴더를 닫으면 늦은 오류와 결과가 다시 나타나지 않는다", async () => {
    const io = fakeIo();
    let fail!: () => void;
    io.scanWorkspace = () => new Promise((_resolve, reject) => { fail = () => reject(new Error("late error")); });
    const store = new AppStore(io);
    const opening = store.openWorkspace("/a");
    await Promise.resolve();
    store.closeWorkspace();
    fail();
    await opening;
    expect(store.state.workspace).toBeNull();
    expect(store.state.workspaceError).toBeNull();
    expect(store.state.workspaceLoading).toBe(false);
    expect(store.state.tree).toEqual([]);
  });
});

describe("워크스페이스 부가 조회 무효화", () => {
  it("이전 폴더의 늦은 이미지 접근 오류를 현재 폴더에 표시하지 않는다", async () => {
    const io = fakeIo();
    let fail!: () => void;
    io.setAssetScope = (path) => path === "/old"
      ? new Promise((_resolve, reject) => { fail = () => reject(new Error("old scope error")); })
      : Promise.resolve();
    const store = new AppStore(io);
    await store.openWorkspace("/old");
    await store.openWorkspace("/new");
    fail();
    await Promise.resolve();
    expect(store.state.workspaceScopeError).toBeNull();
  });

  it("이전 폴더의 백링크 응답이 현재 폴더의 개수와 캐시를 덮지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const io = fakeIo();
      let finish!: () => void;
      io.backlinks = (root) => root === "/old"
        ? new Promise((resolve) => { finish = () => resolve([{}, {}, {}]); })
        : Promise.resolve([]);
      const store = new AppStore(io);
      await store.openPath("/doc.md");
      await store.openWorkspace("/old");
      await vi.advanceTimersByTimeAsync(400);
      await store.openWorkspace("/new");
      await vi.advanceTimersByTimeAsync(400);
      expect(store.active!.backlinks).toBeNull(); // Latest scan waits for the existing read.
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(store.active!.backlinks).toBe(0);
      store.closeWorkspace();
      expect(store.active!.backlinks).toBeNull();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("열린 문서의 저장과 외부 변경은 트리 재조회 없이 연결 조회를 갱신한다", async () => {
    vi.useFakeTimers();
    try {
      const io = fakeIo();
      const scan = vi.spyOn(io, "scanWorkspace");
      io.backlinks = vi.fn().mockResolvedValue([{}]);
      const store = new AppStore(io);
      store.state.workspace = "/tmp";
      await store.openPath("/tmp/ref.md");
      const tab = store.active!;
      const tree = store.state.tree;
      const beforeSave = store.state.linksRevision;
      tab.state = tab.state.update({ changes: { from: 0, insert: "[new](target.md)\n" } }).state;
      tab.dirty = true;
      expect(await store.saveTabById(tab.id)).toBe(true);
      expect(store.state.linksRevision).toBeGreaterThan(beforeSave);
      expect(store.state.tree).toBe(tree);
      expect(scan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      expect(tab.backlinks).toBe(1);
      const beforeEvent = store.state.linksRevision;
      store.externalChange("/tmp/ref.md", "changed");
      expect(store.state.linksRevision).toBeGreaterThan(beforeEvent);
      expect(tab.backlinks).toBeNull();
      await vi.advanceTimersByTimeAsync(400);
      expect(tab.backlinks).toBe(1);
      expect(scan).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("저장 실패는 저장된 연결의 조회 순번을 바꾸지 않는다", async () => {
    vi.useFakeTimers();
    try {
      const io = fakeIo();
      io.writeDocument = async () => { throw new Error("disk full"); };
      const store = new AppStore(io);
      store.state.workspace = "/tmp";
      await store.openPath("/tmp/ref.md");
      const tab = store.active!;
      const revision = store.state.linksRevision;
      tab.state = tab.state.update({ changes: { from: 0, insert: "new" } }).state;
      tab.dirty = true;
      expect(await store.saveTabById(tab.id)).toBe(false);
      expect(store.state.linksRevision).toBe(revision);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("변경 알림이 몰려도 진행 중인 백링크 조회 뒤에는 최신 조회 하나만 실행한다", async () => {
    vi.useFakeTimers();
    try {
      const io = fakeIo();
      let finish!: () => void;
      const read = vi.fn()
        .mockImplementationOnce(() => new Promise<unknown[]>((resolve) => { finish = () => resolve([{}, {}]); }))
        .mockResolvedValue([]);
      io.backlinks = read;
      const store = new AppStore(io);
      store.state.workspace = "/tmp";
      await store.openPath("/tmp/ref.md");
      await vi.advanceTimersByTimeAsync(400);
      store.externalChange("/tmp/ref.md", "changed");
      await vi.advanceTimersByTimeAsync(400);
      store.externalChange("/tmp/ref.md", "changed");
      await vi.advanceTimersByTimeAsync(400);
      expect(read).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect(store.active!.backlinks).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("설정 패치 저장과 창 사이의 순서", () => {
  it("저장 중 같은 항목을 다시 바꿔도 유지하고 다른 창의 변경을 병합한다", async () => {
    const io = fakeIo();
    const store = new AppStore(io);
    const defaults = { ...store.state.settings };
    const requests: Array<{ patch: Partial<Settings>; resolve: (snapshot: SettingsSnapshot) => void }> = [];
    io.patchSettings = (patch) => new Promise((resolve) => requests.push({ patch, resolve }));
    store.acceptSettings({ revision: 1, settings: defaults });
    store.persistSettings({ fontSize: 18 });
    const saving = store.flushSettings();
    store.persistSettings({ fontSize: 21 });
    store.acceptSettings({ revision: 2, settings: { ...defaults, theme: "dark" } });
    expect(store.state.settings.fontSize).toBe(21);
    expect(store.state.settings.theme).toBe("dark");
    expect(requests).toHaveLength(1);
    const first = { revision: 3, settings: { ...defaults, theme: "dark" as const, fontSize: 18 } };
    // 자기 이벤트가 명령 응답보다 먼저 도착해도 최신 입력을 덮지 않는다.
    store.acceptSettings(first);
    expect(store.state.settings.fontSize).toBe(21);
    requests[0].resolve(first);
    await Promise.resolve();
    expect(requests.map((request) => request.patch)).toEqual([{ fontSize: 18 }, { fontSize: 21 }]);
    expect(store.state.settingsPending).toBe(true);
    requests[1].resolve({ revision: 4, settings: { ...first.settings, fontSize: 21 } });
    await saving;
    expect(store.state.settings).toMatchObject({ fontSize: 21, theme: "dark" });
    expect(store.state.settingsPending).toBe(false);
    expect(store.state.settingsSaving).toBe(false);
  });

  it("새 이벤트보다 늦게 도착한 이전 저장 응답·초기 조회를 무시한다", async () => {
    const io = fakeIo();
    const store = new AppStore(io);
    const defaults = { ...store.state.settings };
    let resolve!: (snapshot: SettingsSnapshot) => void;
    io.patchSettings = () => new Promise((done) => { resolve = done; });
    store.persistSettings({ fontSize: 18 });
    const saving = store.flushSettings();
    store.acceptSettings({ revision: 5, settings: { ...defaults, fontSize: 23, theme: "dark" } });
    expect(store.state.settings.fontSize).toBe(18); // 자기 미확정 입력은 응답까지 유지
    resolve({ revision: 4, settings: { ...defaults, fontSize: 18 } });
    await saving;
    store.acceptSettings({ revision: 0, settings: defaults });
    expect(store.state.settings).toMatchObject({ fontSize: 23, theme: "dark" });
    expect(store.state.settingsPending).toBe(false);
  });

  it("저장 실패 시 변경을 유지하고 다른 창의 변경과 함께 재시도한다", async () => {
    const io = fakeIo();
    const store = new AppStore(io);
    const defaults = { ...store.state.settings };
    io.patchSettings = async () => { throw new Error("disk full"); };
    store.persistSettings({ fontSize: 19 });
    await expect(store.flushSettings()).rejects.toThrow("disk full");
    expect(store.state.settingsError).toContain("disk full");
    expect(store.state.settingsPending).toBe(true);
    expect(store.state.settingsSaving).toBe(false);
    store.acceptSettings({ revision: 3, settings: { ...defaults, theme: "dark" } });
    expect(store.state.settings).toMatchObject({ fontSize: 19, theme: "dark" });
    const patches: Partial<Settings>[] = [];
    io.patchSettings = async (patch) => {
      patches.push(patch);
      return { revision: 4, settings: { ...defaults, theme: "dark", ...patch } };
    };
    await store.flushSettings();
    expect(patches).toEqual([{ fontSize: 19 }]);
    expect(store.state.settingsError).toBeNull();
    expect(store.state.settingsPending).toBe(false);
    expect(store.state.settings.theme).toBe("dark");
  });

  it("저장소가 없는 브라우저에서는 로컬 반영 뒤 저장 대기 상태로 남지 않는다", async () => {
    const store = new AppStore(fakeIo());
    store.persistSettings({ fontSize: 20 });
    await store.flushSettings();
    expect(store.state.settings.fontSize).toBe(20);
    expect(store.state.settingsPending).toBe(false);
    expect(store.state.settingsError).toBeNull();
  });
});

describe("메모 대상과 저장 실패 보존", () => {
  const original = { id: 7, lineNo: 1, text: "original", createdAt: 1, resolved: false };
  function setup() {
    const io = fakeIo();
    io.commentList = async () => [{ ...original }];
    const store = new AppStore(io);
    store.newTabWithContent("# document\nbody");
    const tab = store.active!;
    tab.path = "/a.md";
    tab.savedText = tab.state.doc.toString();
    tab.comments = [{ ...original }];
    tab.commentsLoaded = true;
    return { store, io, tab, target: { id: tab.id, path: tab.path } };
  }

  it("조회 오류는 이전 목록을 보존하며 재시도할 수 있다", async () => {
    const { store, io, tab } = setup();
    io.commentList = async () => { throw new Error("locked database"); };
    await store.refreshComments();
    expect(tab.comments).toEqual([original]);
    expect(tab.commentsError).toContain("locked database");
    expect(tab.commentsLoading).toBe(false);
    io.commentList = async () => [];
    await store.refreshComments();
    expect(tab.comments).toEqual([]);
    expect(tab.commentsError).toBeNull();
    expect(tab.commentsLoaded).toBe(true);
  });

  it("늦게 도착한 이전 조회는 최신 목록이나 오류 상태를 덮지 않는다", async () => {
    const { store, io, tab } = setup();
    let finish!: (comments: typeof tab.comments) => void;
    io.commentList = () => new Promise((resolve) => { finish = resolve; });
    const oldRead = store.refreshComments();
    io.commentList = async () => [{ ...original, text: "latest" }];
    await store.refreshComments();
    finish([original]);
    await oldRead;
    expect(tab.comments[0].text).toBe("latest");
    expect(tab.commentsLoading).toBe(false);
  });

  it("작성 후 활성 탭이 바뀌어도 원래 경로에만 추가·재조회한다", async () => {
    const { store, io, tab, target } = setup();
    let finish!: (id: number) => void;
    io.commentAdd = vi.fn(() => new Promise<number>((resolve) => { finish = resolve; }));
    io.commentList = vi.fn(async () => [{ ...original, text: "added" }]);
    const adding = store.addComment(target, 1, "added", tab.state.doc);
    store.newTabWithContent("# second");
    const second = store.active!;
    second.path = "/b.md";
    finish(7);
    await adding;
    expect(io.commentAdd).toHaveBeenCalledWith("/a.md", 1, "added");
    expect(io.commentList).toHaveBeenLastCalledWith("/a.md");
    expect(tab.comments[0].text).toBe("added");
    expect(second.comments).toEqual([]);
  });

  it("수정 실패는 호출자에게 전달하고 수정 전 내용·문서 경로를 서버에 보낸다", async () => {
    const { store, io, tab, target } = setup();
    io.commentUpdate = vi.fn(async () => { throw new Error("conflict"); });
    await expect(store.editComment(target, original, "my edit")).rejects.toThrow("conflict");
    expect(io.commentUpdate).toHaveBeenCalledWith("/a.md", 7, "my edit", { text: "original", resolved: false });
    expect(tab.comments).toEqual([original]);
  });

  it("문서 경로나 본문이 바뀐 추가 요청은 다른 위치로 보내지 않는다", async () => {
    const { store, io, tab, target } = setup();
    io.commentAdd = vi.fn(async () => 8);
    const before = tab.state.doc;
    tab.state = tab.state.update({ changes: { from: 0, insert: "new\n" } }).state;
    await expect(store.addComment(target, 1, "memo", before)).rejects.toThrow();
    tab.path = "/moved.md";
    await expect(store.addComment(target, 1, "memo", tab.state.doc)).rejects.toThrow();
    expect(io.commentAdd).not.toHaveBeenCalled();
  });

  it("실제 저장 성공 후 조회 실패는 추가 실패로 반환하지 않는다", async () => {
    const { store, io, tab, target } = setup();
    io.commentAdd = vi.fn(async () => 8);
    io.commentList = async () => { throw new Error("read unavailable"); };
    await expect(store.addComment(target, 1, "saved", tab.state.doc)).resolves.toBeUndefined();
    expect(io.commentAdd).toHaveBeenCalledTimes(1);
    expect(tab.commentsError).toContain("read unavailable");
    expect(tab.comments).toEqual([original]);
  });
});

describe("변경 추적 기준의 저장과 응답 순서", () => {
  function setup(baseline: string | null = null) {
    const io = fakeIo();
    const store = new AppStore(io);
    store.newTabWithContent("current");
    const tab = store.active!;
    tab.path = "/tracked.md";
    tab.baselineText = baseline;
    tab.baselineRevision = 0;
    tab.baselineLoaded = true;
    io.snapshotBackup = vi.fn(async () => {});
    return { store, io, tab };
  }

  it("저장 중 새로 입력한 내용까지 수락된 것으로 표시하지 않는다", async () => {
    const { store, io, tab } = setup();
    let finish!: (snapshot: BaselineSnapshot) => void;
    io.baselineWrite = vi.fn(() => new Promise<BaselineSnapshot>((resolve) => { finish = resolve; }));
    const saving = store.startTracking();
    tab.state = tab.state.update({ changes: { from: tab.state.doc.length, insert: "\nnew input" } }).state;
    finish({ text: "current", revision: 1 });
    expect(await saving).toBe(true);
    expect(io.baselineWrite).toHaveBeenCalledWith("/tracked.md", "current", { text: null });
    expect(tab.baselineText).toBe("current");
    expect(tab.trackStats?.added).toBe(1);
    expect(tab.baselineBusy).toBe(false);
  });

  it("중지 저장 실패는 기존 추적 기준과 내용을 유지한다", async () => {
    const { store, io, tab } = setup("original");
    io.baselineWrite = async () => { throw new Error("db write failed"); };
    expect(await store.stopTracking()).toBe(false);
    expect(tab.baselineText).toBe("original");
    expect(tab.baselineError).toContain("db write failed");
    expect(io.snapshotBackup).toHaveBeenCalledWith("/tracked.md", "original");
  });

  it("기준 백업 실패는 수락·중지 명령을 보내지 않는다", async () => {
    const { store, io, tab } = setup("original");
    io.snapshotBackup = async () => { throw new Error("backup failed"); };
    io.baselineWrite = vi.fn(async () => ({ text: null, revision: 1 }));
    expect(await store.acceptAllChanges()).toBe(false);
    expect(io.baselineWrite).not.toHaveBeenCalled();
    expect(tab.baselineText).toBe("original");
  });

  it("오래된 조회와 자기 쓰기 응답은 더 최신 기준을 덮지 않는다", async () => {
    const { store, io, tab } = setup();
    let finishWrite!: (snapshot: BaselineSnapshot) => void;
    io.baselineWrite = () => new Promise((resolve) => { finishWrite = resolve; });
    const saving = store.startTracking();
    io.baselineGet = async () => ({ text: "other window", revision: 3 });
    await store.refreshBaseline();
    finishWrite({ text: "current", revision: 2 });
    await saving;
    io.baselineGet = async () => ({ text: null, revision: 0 });
    await store.refreshBaseline();
    expect(tab.baselineText).toBe("other window");
    expect(tab.baselineRevision).toBe(3);
  });

  it("조회 실패는 추적 꺼짐으로 처리하지 않고 재조회할 수 있다", async () => {
    const { store, io, tab } = setup("original");
    io.baselineGet = async () => { throw new Error("unavailable"); };
    await store.refreshBaseline();
    expect(tab.baselineText).toBe("original");
    expect(tab.baselineError).toContain("unavailable");
    io.baselineGet = async () => ({ text: null, revision: 1 });
    await store.refreshBaseline();
    expect(tab.baselineText).toBeNull();
    expect(tab.baselineError).toBeNull();
  });

  it("확인 이후 변경된 문서 스냅샷이나 경로에는 수락을 적용하지 않는다", async () => {
    const { store, io, tab } = setup("original");
    io.baselineWrite = vi.fn(async () => ({ text: "new", revision: 1 }));
    const target = store.trackingTarget()!;
    tab.state = tab.state.update({ changes: { from: 0, insert: "new " } }).state;
    expect(await store.acceptAllChanges(target)).toBe(false);
    expect(io.baselineWrite).not.toHaveBeenCalled();
    expect(tab.baselineText).toBe("original");
  });
});


describe("변경 덩어리 되돌리기 보호", () => {
  it("삭제 복원은 줄 경계를 유지하고 한 번의 실행 취소로 복구된다", () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    store.newTabWithContent("a\nc");
    const tab = store.active!;
    tab.baselineText = "a\nb\nc";
    const doc = view.state.doc;
    const hunk = hunksOf(tab.baselineText, doc.toString())[0];
    expect(store.revertTrackingHunk(view, doc, tab.baselineText, hunk, tab.id)).toBe(true);
    expect(view.state.doc.toString()).toBe("a\nb\nc");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("a\nc");
    view.destroy(); setViewListener(null);
  });

  it("잠금·다른 탭·오래된 문서나 기준의 위젯은 편집하지 않는다", () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    store.newTabWithContent("a");
    const tab = store.active!;
    tab.baselineText = "a\nb";
    const doc = view.state.doc;
    const hunk = hunksOf(tab.baselineText, "a")[0];
    expect(store.revertTrackingHunk(view, doc, tab.baselineText, hunk, "different-tab")).toBe(false);
    expect(store.revertTrackingHunk(view, doc, "old baseline", hunk, tab.id)).toBe(false);
    store.setLocked(tab.id, true);
    expect(store.revertTrackingHunk(view, doc, tab.baselineText, hunk, tab.id)).toBe(false);
    store.setLocked(tab.id, false);
    view.dispatch({ changes: { from: 0, insert: "new " } });
    expect(store.revertTrackingHunk(view, doc, tab.baselineText, hunk, tab.id)).toBe(false);
    expect(view.state.doc.toString()).toBe("new a");
    view.destroy(); setViewListener(null);
  });
});


describe("책갈피 저장·조회·위치 보존", () => {
  it("응답 유실 후 재시도는 같은 추가를 반복하고 중복 토글은 제출하지 않는다", async () => {
    const io = fakeIo();
    const set = io.bookmarkSet!;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    io.bookmarkSet = vi.fn(async (...args: Parameters<NonNullable<StoreIO["bookmarkSet"]>>) => {
      await set(...args);
      await waiting;
      throw new Error("response lost");
    });
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await openTab(store, "/bookmark-retry.md");
      await store.refreshBookmarks();
      const pending = store.toggleBookmark();
      expect(await store.toggleBookmark()).toBe(false);
      expect(store.active!.bookmarks).toEqual([]);
      release();
      expect(await pending).toBe(false);
      expect(io.bookmarkSet).toHaveBeenCalledTimes(1);
      expect(store.active!.bookmarksError).toContain("response lost");
      await store.refreshBookmarks();
      expect(store.active!.bookmarks).toEqual([1]);
      expect(store.active!.bookmarksError).toContain("response lost");
      io.bookmarkSet = set;
      expect(await store.retryBookmarks()).toBe(true);
      expect(store.active!.bookmarks).toEqual([1]);
      expect(store.active!.bookmarksError).toBeNull();
    } finally { view.destroy(); setViewListener(null); }
  });

  it("조회 실패는 기존 목록을 보존하고 늦은 조회는 새 저장을 덮지 않는다", async () => {
    const io = fakeIo();
    const list = io.bookmarkList!;
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await openTab(store, "/bookmark-reads.md");
      await store.refreshBookmarks();
      const old = await list(store.active!.path!);
      let reply!: (value: BookmarkSnapshot) => void;
      io.bookmarkList = () => new Promise((resolve) => { reply = resolve; });
      const stale = store.refreshBookmarks();
      io.bookmarkList = list;
      expect(await store.toggleBookmark()).toBe(true);
      reply(old);
      await stale;
      expect(store.active!.bookmarks).toEqual([1]);
      io.bookmarkList = async () => { throw new Error("offline"); };
      expect(await store.refreshBookmarks()).toBe(false);
      expect(store.active!.bookmarks).toEqual([1]);
      expect(store.active!.bookmarksError).toContain("offline");
      io.bookmarkList = list;
      expect(await store.retryBookmarks()).toBe(true);
      expect(store.active!.bookmarksError).toBeNull();
    } finally { view.destroy(); setViewListener(null); }
  });

  it("책갈피 조회 중 본문이 바뀌면 이전 위치로 쓰지 않는다", async () => {
    const io = fakeIo();
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await openTab(store, "/bookmark-target.md");
      await store.refreshBookmarks();
      const old = await io.bookmarkList!(store.active!.path!);
      let reply!: (value: BookmarkSnapshot) => void;
      io.bookmarkList = () => new Promise((resolve) => { reply = resolve; });
      io.bookmarkSet = vi.fn(io.bookmarkSet!);
      const pending = store.toggleBookmark();
      view.dispatch({ changes: { from: 0, insert: "new\n" } });
      reply(old);
      expect(await pending).toBe(false);
      expect(io.bookmarkSet).not.toHaveBeenCalled();
    } finally { view.destroy(); setViewListener(null); }
  });

  it("편집·되돌리기 위치를 반영하고 저장 실패 후에도 영속 기준에서 재이동한다", async () => {
    const io = fakeIo();
    const replace = io.bookmarkReplace!;
    const store = new AppStore(io);
    const view = mount(store);
    try {
      await openTab(store, "/bookmark-anchor.md");
      await store.refreshBookmarks();
      const tab = store.active!;
      const original = tab.savedText;
      view.dispatch({ selection: { anchor: view.state.doc.line(3).from } });
      expect(await store.toggleBookmark()).toBe(true);
      view.dispatch({ changes: { from: 0, insert: "intro\n" } });
      expect(store.bookmarkLinesFor(tab)).toEqual([4]);
      view.dispatch({ changes: { from: 0, to: 6 } });
      expect(store.bookmarkLinesFor(tab)).toEqual([3]);
      view.dispatch({ changes: { from: 0, insert: "intro\n" } });
      io.bookmarkReplace = async () => { throw new Error("disk full"); };
      expect(await store.saveTabById(tab.id)).toBe(true);
      expect(tab.bookmarksText).toBe(original);
      expect(tab.bookmarks).toEqual([3]);
      expect(tab.bookmarksError).toContain("disk full");
      await store.refreshBookmarks();
      expect(tab.bookmarksError).toContain("disk full");
      view.dispatch({ changes: { from: 0, insert: "second\n" } });
      io.bookmarkReplace = replace;
      // 메모 위치 저장 실패가 책갈피 저장까지 막지 않는다.
      tab.comments = [{ id: 1, lineNo: 1, text: "memo", createdAt: 1, resolved: false }];
      io.commentReanchor = async () => { throw new Error("comment failure"); };
      expect(await store.saveTabById(tab.id)).toBe(true);
      expect(tab.bookmarks).toEqual([5]);
      expect(tab.bookmarksText).toBe(tab.savedText);
      expect(tab.bookmarksError).toBeNull();
    } finally { view.destroy(); setViewListener(null); }
  });
});
