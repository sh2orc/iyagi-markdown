// 소스 모드 오른쪽 미리보기 — 왼쪽 소스와 같은 문서를 읽기 스타일로 렌더.
// 내보내기 파이프라인(renderExportBody·buildExportHtml)을 그대로 타서
// 내보내기와 같은 문서 스냅샷을 사용한다. 본문 캐시는 이 패널에만 둔다. 렌더는
// 300ms 디바운스, 왼쪽 스크롤을 오른쪽에 비례 동기(rAF 스로틀).
// 폭 드래그는 RefPane 규약(컨테이너 % · localStorage 저장 · 클램프).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { api } from "../api";
import { captureExportSnapshot, type ExportSnapshot } from "../export/snapshot";
import { createPreviewRenderer, snapshotHtmlOptions } from "../export/preview";
import type { Translate } from "../i18n";
import type { AppStore, Tab } from "../app/store";

const SRC_W_KEY = "iyagi.sourcePreviewWidth";

/** 폭 퍼센트 클램프(순수) — 편집기 최소 20% 확보·미리보기 최대 80%. */
export function clampPreviewWidth(w: number): number {
  return Math.min(80, Math.max(20, w));
}

/** 스크롤 비례 매핑(순수) — 왼쪽 위치를 오른쪽 창 높이에 적용할 값으로. */
export function syncedScrollTop(
  from: { scrollTop: number; scrollHeight: number; clientHeight: number },
  to: { scrollHeight: number; clientHeight: number },
): number {
  const denom = from.scrollHeight - from.clientHeight;
  const ratio = denom > 0 ? Math.max(0, Math.min(1, from.scrollTop / denom)) : 0;
  const toDenom = Math.max(0, to.scrollHeight - to.clientHeight);
  return ratio * toDenom;
}

export function SourcePreview({
  store,
  tab,
  t,
}: {
  store: AppStore;
  tab: Tab;
  t: Translate;
}): JSX.Element {
  const [html, setHtml] = useState("");
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [renderedSnapshot, setRenderedSnapshot] = useState<ExportSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const renderer = useRef<ReturnType<typeof createPreviewRenderer> | null>(null);
  if (!renderer.current) renderer.current = createPreviewRenderer();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [w, setW] = useState<number>(() => {
    const saved = Number(localStorage.getItem(SRC_W_KEY));
    return saved >= 20 && saved <= 80 ? saved : 50;
  });
  const dragRef = useRef<{ x: number; w: number; splitW: number } | null>(null);

  // 폭 드래그 — 커서 이동에 따라 퍼센트 갱신(놓으면 저장).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // 미리보기 폭은 .source-split(사이드바·참조 페인 제외)의 % — 창 폭이
      // 아니라 그 컨테이너 폭으로 나눠야 커서와 리사이저가 붙어 따라온다.
      setW(clampPreviewWidth(d.w + ((d.x - e.clientX) / d.splitW) * 100));
    };
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.classList.remove("resizing");
        setW((cur) => {
          localStorage.setItem(SRC_W_KEY, String(Math.round(cur)));
          return cur;
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);
  const snapshot = useMemo(() => captureExportSnapshot(tab, {
    workspace: state.workspace, theme: state.theme, pageNumbers: false, header: false,
    wikiIndex: store.wikiIndex, lang: t.lang,
  }), [tab, tab.state.doc, tab.path, tab.title, tab.docStyle, state.workspace, state.theme,
    store.wikiIndex, state.linksRevision, t.lang]);

  useEffect(() => {
    let alive = true;
    setError(null);
    const id = setTimeout(() => {
      const options = snapshotHtmlOptions(snapshot, async (path) => {
        try { return new Uint8Array(await api.readFileBytes(path)); } catch { return null; }
      });
      void renderer.current!(snapshot, options).then((built) => {
        if (alive) { setHtml(built); setRenderedSnapshot(snapshot); }
      }).catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason));
      });
    }, 300);
    return () => { alive = false; clearTimeout(id); };
  }, [snapshot, retry]);

  // 왼쪽(소스) 스크롤 → 오른쪽 비례 동기.
  useEffect(() => {
    const view = store.view;
    if (!view) return;
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const doc = frameRef.current?.contentWindow?.document;
        if (!doc?.documentElement) return;
        frameRef.current!.contentWindow!.scrollTo(
          0,
          syncedScrollTop(view.scrollDOM, doc.documentElement),
        );
      });
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => view.scrollDOM.removeEventListener("scroll", onScroll);
  }, [store, html]);

  // 키보드 리사이즈 — ←→로 구분선 이동(APG separator 관례: 방향키=이동).
  const stepWidth = (delta: number): void => {
    setW((cur) => {
      const next = clampPreviewWidth(cur + delta);
      localStorage.setItem(SRC_W_KEY, String(Math.round(next)));
      return next;
    });
  };

  return (
    <div className="src-preview" style={{ flexBasis: `${w}%` }}>
      <div
        className="src-preview-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t.previewPaneTitle}
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(w)}
        tabIndex={0}
        onPointerDown={(e) => {
          dragRef.current = {
            x: e.clientX,
            w,
            splitW: (e.currentTarget as HTMLElement).closest(".source-split")?.clientWidth || window.innerWidth,
          };
          document.body.classList.add("resizing");
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            stepWidth(2); // 구분선 왼쪽 이동 = 미리보기 확대
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            stepWidth(-2);
          }
        }}
      />
      {error ? <div className="preview-error" role="alert">
        <p>{t.previewFailed}: {error}</p>
        <button className="btn" onClick={() => { renderer.current = createPreviewRenderer(); setRetry((value) => value + 1); }}>{t.wsRetry}</button>
      </div> : html && renderedSnapshot === snapshot ? (
        <iframe
          ref={frameRef}
          title={t.previewPaneTitle}
          srcDoc={html}
          sandbox="allow-same-origin"
          onLoad={onScroll0(store, frameRef)}
        />
      ) : (
        <div className="src-preview-loading" role="status" aria-label={t.loading}>
          <div className="spinner" />
        </div>
      )}
    </div>
  );
}

/** 첫 렌더 직후 위치 동기(iframe 문서 준비 후). */
function onScroll0(
  store: AppStore,
  frameRef: React.RefObject<HTMLIFrameElement | null>,
): () => void {
  return () => {
    const view = store.view;
    const doc = frameRef.current?.contentWindow?.document;
    if (view && doc?.documentElement) {
      frameRef.current?.contentWindow?.scrollTo(
        0,
        syncedScrollTop(view.scrollDOM, doc.documentElement),
      );
    }
  };
}
