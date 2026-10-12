// 목차 패널 — 활성 문서의 제목 트리(Word 네비게이션 창 방향).
// · 검색 필터(긴 문서 빠른 점프) · 수준별 접기(chevron, 하위 수 배지)
// · 스크롤 스파이 현재 제목 강조 + 조상 경로 표시 · 키보드 ↑↓·Enter 탐색
// 편집이 멈춘 뒤 짧은 지연 후 재계산한다(키 입력마다 재스캔 방지).

import { useEffect, useMemo, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

import type { AppStore } from "../app/store";
import { smoothScrollIntoView } from "../editor/cm";
import { collectHeadings, type Heading } from "../links";
import { ancestorSlugs, filterHeadings, tocTree, visibleNodes } from "../app/tocTree";
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
  /** 접힌 제목 slug — 문서가 살짝 바뀌어도 접기가 풀리지 않게. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [selIdx, setSelIdx] = useState(-1);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

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

  const roots = useMemo(() => tocTree(headings), [headings]);
  const filtered = useMemo(() => filterHeadings(headings, query), [headings, query]);
  const visible = useMemo(
    () => (filtered ? [] : visibleNodes(roots, collapsed)),
    [filtered, roots, collapsed],
  );
  const ancestors = useMemo(
    () => (activeIdx >= 0 && headings[activeIdx] ? ancestorSlugs(roots, headings[activeIdx].slug) : new Set<string>()),
    [roots, headings, activeIdx],
  );

  // 스크롤 스파이 — 화면 상단+72px에 보이는 문서 위치로 현재 제목 추적.
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
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.inert = !open;
  }, [open]);

  // 강조 항목이 보이는 범위를 벗어나면 따라감.
  useEffect(() => {
    if (activeIdx < 0 || !bodyRef.current) return;
    const el = bodyRef.current.querySelector(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const goto = (pos: number, view: EditorView | null) => {
    if (!view) return;
    smoothScrollIntoView(view, Math.min(pos, view.state.doc.length));
    view.focus();
  };

  const toggleCollapse = (slug: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  // 키보드 탐색 — ↑↓ 선택 이동, Enter 점프(필터 중에도 같은 목록 순서로).
  const moveSel = (delta: number) => {
    const list = filtered ?? visible.map((n) => n.heading);
    if (list.length === 0) return;
    setSelIdx((prev) => {
      const next = prev < 0 ? 0 : Math.min(list.length - 1, Math.max(0, prev + delta));
      return next;
    });
  };

  const selPos = (): number | null => {
    const list = filtered ?? visible.map((n) => n.heading);
    if (selIdx < 0 || selIdx >= list.length) return null;
    return list[selIdx]!.pos;
  };

  // 헤더 배지 — 제목·책갈피 수.
  const bookmarkCount = tab?.bookmarks?.length ?? 0;

  const renderNode = (node: (typeof roots)[number]) => {
    const h = node.heading;
    const isActive = node.idx === activeIdx;
    const isAncestor = ancestors.has(h.slug);
    const hasKids = node.children.length > 0;
    const isCollapsed = collapsed.has(h.slug);
    const isSel = filtered !== null && selIdx >= 0 && filtered[selIdx] === h;
    const cls = [
      "toc-item",
      `toc-l${h.level}`,
      isActive ? "is-active" : "",
      isAncestor && !isActive ? "is-ancestor" : "",
      isCollapsed && hasKids ? "is-collapsed" : "",
      isSel ? "is-sel" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <div key={`${h.slug}-${node.idx}`} className="toc-row" data-idx={node.idx} data-d={node.depth}>
        {hasKids ? (
          <button
            className={`toc-chevron ${isCollapsed ? "is-collapsed" : ""}`}
            title={isCollapsed ? "펼치기" : "접기"}
            onClick={() => toggleCollapse(h.slug)}
          >
            ▸
          </button>
        ) : (
          <span className="toc-chevron toc-chevron-none" />
        )}
        <button className={cls} style={{ "--d": node.depth } as React.CSSProperties} onClick={() => goto(h.pos, store.view)}>
          <span className="toc-text">{h.text || "—"}</span>
          {isCollapsed && hasKids && node.descendantCount > 0 && (
            <span className="toc-fold-badge">{node.descendantCount}</span>
          )}
        </button>
      </div>
    );
  };

  return (
    <div className={`toc ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <div ref={bodyRef} className="toc-fixed">
        <div className="toc-head">
          <span className="toc-head-title">{t.tocTitle}</span>
          {headings.length > 0 && <span className="toc-count">{headings.length}</span>}
        </div>
        {headings.length > 6 && (
          <input
            ref={searchRef}
            className="toc-search"
            placeholder={t.tocFilter}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelIdx(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                moveSel(1);
              } else if (e.key === "Enter") {
                const p = selPos();
                if (p != null) goto(p, store.view);
              } else if (e.key === "Escape") {
                setQuery("");
              }
            }}
          />
        )}
        <div
          className="toc-body"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              moveSel(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              moveSel(-1);
            } else if (e.key === "Enter") {
              const p = selPos();
              if (p != null) goto(p, store.view);
            }
          }}
        >
          {bookmarkCount > 0 && (
            <div className="toc-bookmarks">
              <div className="sidebar-subtitle">★ {t.bookmarksSection}</div>
              {tab!.bookmarks.map((line) => (
                <button key={line} className="toc-item toc-bookmark-item" onClick={() => store.gotoBookmark(line)}>
                  <span className="toc-bm-line">{line}</span>
                  <span className="toc-text">
                    {(doc ? doc.line(Math.min(line, doc.lines)).text.slice(0, 24) : "") || "—"}
                  </span>
                </button>
              ))}
            </div>
          )}
          {headings.length === 0 && <div className="toc-empty">{t.tocEmpty}</div>}
          {filtered !== null
            ? filtered.map((h, i) => (
                <button
                  key={`${h.slug}-f${i}`}
                  className={`toc-item toc-l${h.level} ${i === selIdx ? "is-sel" : ""}`}
                  style={{ "--d": Math.max(0, h.level - 1) } as React.CSSProperties}
                  onClick={() => goto(h.pos, store.view)}
                >
                  <span className="toc-text">{h.text || "—"}</span>
                </button>
              ))
            : visible.map((n) => renderNode(n))}
          {filtered !== null && filtered.length === 0 && (
            <div className="toc-empty toc-empty-filter">{t.tocEmpty}</div>
          )}
        </div>
      </div>
    </div>
  );
}
