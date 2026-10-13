// 참조 보기 — 옆에 고정한 문서를 읽기 전용으로 나란히(Word "정렬"·
// Scrivener 참조). 내보내기 파이프라인(buildExportHtml)으로 렌더해
// 문서 스타일·캡션·목차까지 본문과 동일하게 보인다.

import { useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

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

const REF_W_KEY = "iyagi.refPaneWidth";

export function RefPane({ store, t, tabId, onClose }: Props): JSX.Element | null {
  const [refW, setRefW] = useState<number>(() => {
    const saved = Number(localStorage.getItem(REF_W_KEY));
    return saved >= 20 && saved <= 60 ? saved : 42;
  });
  const dragRef = useRef<{ x: number; w: number } | null>(null);
  /** 편집 모드 — 읽기 iframe 대신 진짜 에디터(분할 편집). */
  const [editMode, setEditMode] = useState(false);
  const editHost = useRef<HTMLDivElement | null>(null);
  const editView = useRef<EditorView | null>(null);
  /** iframe 스크롤 위치 — 재렌더(살아 있는 복제본)마다 유지. */
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameScroll = useRef(0);

  // 폭 드래그 — 커서 이동에 따라 퍼센트 갱신(놓으면 저장).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const pct = d.w + ((d.x - e.clientX) / window.innerWidth) * 100;
      setRefW(Math.min(60, Math.max(20, pct)));
    };
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.classList.remove("resizing");
        setRefW((w) => {
          localStorage.setItem(REF_W_KEY, String(Math.round(w)));
          return w;
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
  const tab = store.state.tabs.find((x) => x.id === tabId) ?? null;
  const [html, setHtml] = useState<string | null>(null);
  const doc = tab?.state.doc;

  // 분할 편집 뷰 — 탭 상태를 그대로 얹는다(확장 포함). 스토어 라우팅용 등록.
  useEffect(() => {
    if (!editMode || !tab || !editHost.current) {
      editView.current?.destroy();
      editView.current = null;
      store.splitView = null;
      store.splitTabId = null;
      return;
    }
    const v = new EditorView({ state: tab.state, parent: editHost.current });
    editView.current = v;
    store.splitView = v;
    store.splitTabId = tab.id;
    return () => {
      v.destroy();
      editView.current = null;
      store.splitView = null;
      store.splitTabId = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, tabId]);

  useEffect(() => {
    if (!tab || !doc || editMode) {
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
        if (alive) {
          // 재렌더 전 스크롤 저장(sandbox allow-same-origin — 스크립트는 불가).
          try {
            frameScroll.current = frameRef.current?.contentWindow?.scrollY ?? frameScroll.current;
          } catch {
            /* 접근 거부 시 이전 값 */
          }
          setHtml(built);
        }
      })();
    }, 400);
    return () => {
      alive = false;
      clearTimeout(id);
    };
    // 문서 편집에 250ms 디바운스로 재렌더 — 참조가 살아 있는 복사본.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, tab?.path, store.state.theme, editMode]);

  if (!tab) return null;

  return (
    <div className="ref-pane" style={{ flexBasis: `${refW}%` }}>
      <div
        className="ref-pane-resizer"
        onPointerDown={(e) => {
          dragRef.current = { x: e.clientX, w: refW };
          document.body.classList.add("resizing");
        }}
      />
      <div className="ref-pane-head">
        <span className="ref-pane-title">📖 {t.refPaneTitle} · {tab.path ? tab.title : t.untitled}</span>
        <button
          className="ref-pane-edit"
          title={tab.id === store.state.activeId ? t.refEditBlocked : editMode ? t.refReadMode : t.refEditMode}
          disabled={tab.id === store.state.activeId}
          onClick={() => setEditMode((e) => !e)}
        >
          {editMode ? "📖" : "✎"}
        </button>
        <button className="ref-pane-close" title={t.closeTab} onClick={onClose}>
          ✕
        </button>
      </div>
      {editMode ? (
        <div className="ref-pane-editor" ref={editHost} />
      ) : html == null ? (
        <div className="ref-pane-loading">
          <div className="spinner" />
        </div>
      ) : (
        <iframe
          ref={frameRef}
          className="ref-pane-body"
          title={t.refPaneTitle}
          srcDoc={html}
          sandbox="allow-same-origin"
          onLoad={() => {
            try {
              if (frameScroll.current > 0) {
                frameRef.current?.contentWindow?.scrollTo(0, frameScroll.current);
              }
            } catch {
              /* 무시 */
            }
          }}
        />
      )}
    </div>
  );
}
