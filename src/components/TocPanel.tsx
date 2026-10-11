// 목차 패널 — 활성 문서의 제목 트리(M09). 활성 에디터 상태에서 제목을 뽑는다.

import { useMemo } from "react";
import { EditorView } from "@codemirror/view";

import type { AppStore } from "../app/store";
import { collectHeadings } from "../links";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
}

export function TocPanel({ store, t }: Props): JSX.Element {
  const state = store.getSnapshot();
  const tab = state.tabs.find((x) => x.id === state.activeId) ?? null;

  const headings = useMemo(() => {
    if (!tab) return [];
    return collectHeadings(tab.state.doc.toString());
  }, [tab, tab?.state]);

  const goto = (pos: number, view: EditorView | null) => {
    if (!view) return;
    view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: true });
  };

  return (
    <aside className="toc">
      <div className="toc-head">{t.tocTitle}</div>
      <div className="toc-body">
        {headings.length === 0 && <div className="toc-empty">{t.tocEmpty}</div>}
        {headings.map((h, i) => (
          <button
            key={`${h.slug}-${i}`}
            className="toc-item"
            style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
            onClick={() => goto(h.pos, store.view)}
          >
            {h.text || "—"}
          </button>
        ))}
      </div>
    </aside>
  );
}
