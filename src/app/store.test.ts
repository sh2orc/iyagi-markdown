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
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

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
