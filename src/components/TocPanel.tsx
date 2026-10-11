// 목차 패널 — 활성 문서의 제목 트리(M09). 활성 에디터 상태에서 제목을 뽑는다.
// 열고 닫을 때 언마운트하지 않고 슬라이드한다. 제목 목록은 편집이 멈춘 뒤
// 짧은 지연 후 재계산한다 — 키 입력 한 번 한 번이 문서 전체 재스캔이 되지 않게.

import { useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

import type { AppStore } from "../app/store";
import { collectHeadings, type Heading } from "../links";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  open: boolean;
}

export function TocPanel({ store, t, open }: Props): JSX.Element {
  const state = store.getSnapshot();
  const tab = state.tabs.find((x) => x.id === state.activeId) ?? null;
  const doc = tab?.state.doc;
  const [headings, setHeadings] = useState<Heading[]>([]);

  useEffect(() => {
    if (!doc) {
      setHeadings([]);
      return;
    }
    const id = setTimeout(() => {
      setHeadings(collectHeadings(doc.toString()));
    }, 150);
    return () => clearTimeout(id);
  }, [doc]);

  // 닫힌 상태에서는 포커스가 들어가지 않게.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.inert = !open;
  }, [open]);

  const goto = (pos: number, view: EditorView | null) => {
    if (!view) return;
    view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) }, scrollIntoView: true });
  };

  return (
    <div className={`toc ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <div ref={bodyRef} className="toc-fixed">
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
      </div>
    </div>
  );
}
