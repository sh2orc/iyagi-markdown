// 참조 보기 — 옆에 고정한 문서를 읽기 전용으로 나란히(Word "정렬"·
// Scrivener 참조). 내보내기 파이프라인(buildExportHtml)으로 렌더해
// 문서 스타일·캡션·목차까지 본문과 동일하게 보인다.

import { useEffect, useState } from "react";

import { api } from "../api";
import { resolveWikiLink } from "../editor/wiki";
import type { AppStore } from "../app/store";
import { stripFrontMatter } from "../editor/frontmatter";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  tabId: string;
  onClose: () => void;
}

export function RefPane({ store, t, tabId, onClose }: Props): JSX.Element | null {
  const tab = store.state.tabs.find((x) => x.id === tabId) ?? null;
  const [html, setHtml] = useState<string | null>(null);
  const doc = tab?.state.doc;

  useEffect(() => {
    if (!tab || !doc) {
      setHtml(null);
      return;
    }
    let alive = true;
    const text = tab.state.doc.toString();
    const baseDir = tab.path ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/" : store.state.workspace ?? "";
    setHtml(null);
    const id = setTimeout(() => {
      void (async () => {
        const { buildExportHtml } = await import("../export/html");
        const built = await buildExportHtml(stripFrontMatter(text), {
          title: tab.path ? tab.title : "untitled",
          baseDir,
          theme: store.state.theme,
          style: {
            font: tab.docStyle?.font ?? "system",
            sizePt: tab.docStyle && tab.docStyle.fontSize > 0 ? tab.docStyle.fontSize : 11,
            lineHeight: tab.docStyle?.lineHeight ?? 0,
            firstLineIndent: tab.docStyle?.firstLineIndent ?? false,
            textAlign: tab.docStyle?.textAlign ?? "left",
            accent: tab.docStyle?.accent ?? null,
          },
          wikiResolve: (name) => resolveWikiLink(name, baseDir, store.wikiIndex),
          readBytes: async (p) => {
            try {
              return new Uint8Array(await api.readFileBytes(p));
            } catch {
              return null;
            }
          },
        });
        if (alive) setHtml(built);
      })();
    }, 250);
    return () => {
      alive = false;
      clearTimeout(id);
    };
    // 문서 편집에 250ms 디바운스로 재렌더 — 참조가 살아 있는 복사본.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, tab?.path, store.state.theme]);

  if (!tab) return null;

  return (
    <div className="ref-pane">
      <div className="ref-pane-head">
        <span className="ref-pane-title">📖 {t.refPaneTitle} · {tab.path ? tab.title : t.untitled}</span>
        <button className="ref-pane-close" title={t.closeTab} onClick={onClose}>
          ✕
        </button>
      </div>
      {html == null ? (
        <div className="ref-pane-loading">
          <div className="spinner" />
        </div>
      ) : (
        <iframe className="ref-pane-body" title={t.refPaneTitle} srcDoc={html} sandbox="" />
      )}
    </div>
  );
}
