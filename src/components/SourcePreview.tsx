// 소스 모드 오른쪽 미리보기 — 왼쪽 소스와 같은 문서를 읽기 스타일로 렌더.
// 내보내기 파이프라인(renderExportBody·buildExportHtml)을 그대로 타서
// "미리보기=내보내기 결과"가 보장된다(인쇄 미리보기와 캐시 공유). 렌더는
// 300ms 디바운스, 왼쪽 스크롤을 오른쪽에 비례 동기(rAF 스로틀).

import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { previewBodyCache } from "./PrintPreview";
import { frontMatterMeta } from "../editor/frontmatter";
import { resolveWikiLink } from "../editor/wiki";
import type { AppStore, Tab } from "../app/store";

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

export function SourcePreview({ store, tab }: { store: AppStore; tab: Tab }): JSX.Element {
  const [html, setHtml] = useState("");
  const frameRef = useRef<HTMLIFrameElement | null>(null);
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

  return (
    <div className="src-preview">
      {html ? (
        <iframe
          ref={frameRef}
          title="preview"
          srcDoc={html}
          sandbox="allow-same-origin"
          onLoad={onScroll0(store, frameRef)}
        />
      ) : (
        <div className="src-preview-loading" />
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
