// 소스 모드 오른쪽 미리보기 — 왼쪽 소스와 같은 문서를 읽기 스타일로 렌더.
// 내보내기 파이프라인(renderExportBody·buildExportHtml)을 그대로 타서
// "미리보기=내보내기 결과"가 보장된다(인쇄 미리보기와 캐시 공유). 렌더는
// 300ms 디바운스, 왼쪽 스크롤을 오른쪽에 비례 동기(rAF 스로틀).
// 폭 드래그는 RefPane 규약(컨테이너 % · localStorage 저장 · 클램프).

import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { previewBodyCache } from "./PrintPreview";
import { frontMatterMeta } from "../editor/frontmatter";
import { resolveWikiLink } from "../editor/wiki";
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
  t: { previewPaneTitle: string };
}): JSX.Element {
  const [html, setHtml] = useState("");
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
  const baseDir = tab.path
    ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/"
    : store.state.workspace ?? "";
  const text = tab.state.doc.toString();
  const theme = store.state.theme;

  useEffect(() => {
    let alive = true;
    const id = setTimeout(() => {
      void (async () => {
        const { buildExportHtml, renderExportBody } = await import("../export/html");
        let cached = previewBodyCache.get(text);
        if (cached === undefined) {
          cached = await renderExportBody(text, {
            title: tab.path ? tab.title : "untitled",
            theme,
            baseDir,
            wikiResolve: (name: string) => resolveWikiLink(name, baseDir, store.wikiIndex),
            readBytes: async (p: string) => {
              try {
                return new Uint8Array(await api.readFileBytes(p));
              } catch {
                return null;
              }
            },
          });
          previewBodyCache.set(text, cached);
          if (previewBodyCache.size > 3) {
            previewBodyCache.delete(previewBodyCache.keys().next().value as string);
          }
        }
        const ds = tab.docStyle;
        const fm = frontMatterMeta(text);
        const built = await buildExportHtml(text, {
          preRendered: cached,
          title: fm?.title || (tab.path ? tab.title : "untitled"),
          baseDir,
          theme,
          forPdf: false,
          imageWidths: ds?.imageWidths ?? {},
          tableWidths: ds?.tableWidths ?? {},
          style: {
            font: ds?.font ?? "system",
            sizePt: ds && ds.fontSize > 0 ? ds.fontSize : 11,
            lineHeight: ds?.lineHeight ?? 0,
            firstLineIndent: ds?.firstLineIndent ?? false,
            textAlign: ds?.textAlign ?? "left",
            accent: ds?.accent ?? null,
          },
          wikiResolve: (name: string) => resolveWikiLink(name, baseDir, store.wikiIndex),
          readBytes: async (p: string) => {
            try {
              return new Uint8Array(await api.readFileBytes(p));
            } catch {
              return null;
            }
          },
        });
        if (alive) setHtml(built);
      })();
    }, 300);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [text, theme, baseDir, tab, store]);

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
      {html ? (
        <iframe
          ref={frameRef}
          title={t.previewPaneTitle}
          srcDoc={html}
          sandbox="allow-same-origin"
          onLoad={onScroll0(store, frameRef)}
        />
      ) : (
        <div className="src-preview-loading">
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
