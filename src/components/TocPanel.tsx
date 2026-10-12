// 목차 패널 — 활성 문서의 제목 트리(M09). 활성 에디터 상태에서 제목을 뽑는다.
// 열고 닫을 때 언마운트하지 않고 슬라이드한다. 제목 목록은 편집이 멈춘 뒤
// 짧은 지연 후 재계산한다 — 키 입력 한 번 한 번이 문서 전체 재스캔이 되지 않게.
// 스크롤 스파이: 화면 상단에 가장 가까운 제목을 강조해 현재 위치를 보여 준다.

import { useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

import type { AppStore } from "../app/store";
import { smoothScrollIntoView } from "../editor/cm";
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
  const [activeIdx, setActiveIdx] = useState(-1);

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

  // 스크롤 스파이 — 화면 상단+72px에 보이는 문서 위치로 현재 제목 추적.
  // rAF로 모으고, 읽기 모드는 스크롤 컨테이너가 editor-area라 양쪽에 건다.
  useEffect(() => {
    const view = store.view;
    if (!view || headings.length === 0) {
      setActiveIdx(-1);
      return;
    }
    let raf = 0;
    const spy = () => {
      raf = 0;
      const rect = view.dom.getBoundingClientRect();
      const pos = view.posAtCoords({
        x: rect.left + Math.min(120, rect.width / 2),
        y: rect.top + 72,
      });
      if (pos == null) return;
      let idx = -1;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i].pos <= pos) idx = i;
        else break;
      }
      setActiveIdx((prev) => (prev === idx ? prev : idx));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(spy);
    };
    const area = view.scrollDOM.closest(".editor-area");
    const hosts: Element[] = area ? [view.scrollDOM, area] : [view.scrollDOM];
    spy();
    for (const h of hosts) h.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      for (const h of hosts) h.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [store, headings]);

  // 닫힌 상태에서는 포커스가 들어가지 않게.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.inert = !open;
  }, [open]);

  // 강조 항목이 TOC 보이는 범위를 벗어나면 따라감.
  useEffect(() => {
    if (activeIdx < 0 || !bodyRef.current) return;
    const el = bodyRef.current.children[activeIdx + 1] as HTMLElement | undefined; // +1 = head
    if (el?.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const goto = (pos: number, view: EditorView | null) => {
    if (!view) return;
    smoothScrollIntoView(view, Math.min(pos, view.state.doc.length));
  };

  return (
    <div className={`toc ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <div ref={bodyRef} className="toc-fixed">
        <div className="toc-head">{t.tocTitle}</div>
        <div className="toc-body">
          {(tab?.bookmarks?.length ?? 0) > 0 && (
            <div className="toc-bookmarks">
              <div className="sidebar-subtitle">★ {t.bookmarksSection}</div>
              {tab!.bookmarks.map((line) => (
                <button key={line} className="toc-item toc-bookmark-item" onClick={() => store.gotoBookmark(line)}>
                  {line}줄 · {(doc ? doc.line(Math.min(line, doc.lines)).text.slice(0, 24) : "") || "—"}
                </button>
              ))}
            </div>
          )}
          {headings.length === 0 && <div className="toc-empty">{t.tocEmpty}</div>}
          {headings.map((h, i) => (
            <button
              key={`${h.slug}-${i}`}
              className={`toc-item ${i === activeIdx ? "is-active" : ""}`}
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
