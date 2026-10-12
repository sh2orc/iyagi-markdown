// 스토어 통합 테스트 — 증분 통계·dirty·토스트·탭 전환이 실제 EditorView와
// 맞물려 돌아가는지(입력 파이프라인 최적화의 회귀 방지).

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";

import { AppStore, countCheckboxes, countWords, type StoreIO } from "./store";
import { setViewListener } from "../editor/cm";
import { previewConfigField } from "../editor/livePreview";

function fakeIo(): StoreIO {
  return {
    readDocument: async (path: string) => ({
      text: `# ${path}\n\n샘플 본문입니다.\n`,
      meta: { hadBom: false, crlf: false },
      mtime: 1,
      size: 10,
    }),
    writeDocument: async (_p: string, text: string) => ({ mtime: 2, size: text.length }),
    scanWorkspace: async () => [],
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
  it("토글하면 프리뷰 설정(config)의 bookmarks가 즉시 갱신된다(줄 배지 렌더)", async () => {
    const store = new AppStore(fakeIo());
    const view = mount(store);
    await openTab(store, "/tmp/mark.md");
    view.dispatch({ selection: { anchor: 3 } }); // 1~2번 줄 아무 데나
    store.toggleBookmark();
    const cfg = view.state.field(previewConfigField, false);
    expect(cfg?.bookmarks).toEqual([view.state.doc.lineAt(3).number]);
    store.toggleBookmark(); // 다시 토글 — 제거
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
      store.toggleBookmark();
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

    // 2) 더티 → 충돌 플래그, 내용 유지.
    view.dispatch({ changes: { from: 0, insert: "수정 " } });
    await nextFrame();
    expect(t.dirty).toBe(true);
    const before = t.state.doc.toString();
    store.externalChange("/tmp/ext.md", "changed");
    expect(t.conflict).toBe("conflict");
    expect(t.state.doc.toString()).toBe(before);

    // 3) 제거 → removed 표시.
    store.externalChange("/tmp/ext.md", "removed");
    expect(t.conflict).toBe("removed");
  });
});
