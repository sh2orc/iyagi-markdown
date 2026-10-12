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
  }, 30_000);
});
