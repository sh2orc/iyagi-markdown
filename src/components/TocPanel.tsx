// 목차 패널 — 활성 문서의 제목 트리(Word 네비게이션 창 방향).
// · 검색 필터(긴 문서 빠른 점프) · 수준별 접기(chevron, 하위 수 배지)
// · 스크롤 스파이 현재 제목 강조 + 조상 경로 표시 · 방향키 계층 탐색·Enter 이동
// 편집이 멈춘 뒤 짧은 지연 후 재계산한다(키 입력마다 재스캔 방지).

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";

import type { AppStore } from "../app/store";
import { imeComposing } from "../app/ime";
import { collectHeadings, type Heading } from "../links";
import { ancestorSlugs, filterHeadings, tocTree, visibleNodes } from "../app/tocTree";
import { sectionMoveChanges } from "../editor/sectionMove";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  open: boolean;
}
const EMPTY_HEADINGS: Heading[] = [];

export function TocPanel({ store, t, open }: Props): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const tab = state.tabs.find((x) => x.id === state.activeId) ?? null;
  const doc = tab?.state.doc;
  const [snapshot, setSnapshot] = useState<{ id: string; doc: NonNullable<typeof doc>; headings: Heading[] } | null>(null);
  const ready = snapshot?.id === tab?.id && snapshot?.doc === doc;
  const headings = ready && snapshot ? snapshot.headings : EMPTY_HEADINGS;
  const [activeIdx, setActiveIdx] = useState(-1);
  /** 접힌 제목 slug — 문서가 살짝 바뀌어도 접기가 풀리지 않게. */
  // 접힘 상태는 스토어가 소유(세션 저장·복원).
  const collapsed = store.tocCollapsed;
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<{ id: string; slug: string } | null>(null);
  const [, setTick] = useState(0);
  /** 개요 드래그 재배치 — 원본 제목 인덱스(Word 네비게이션 창 방식). */
  const [dragHead, setDragHead] = useState<{ idx: number; over: number; id: string; doc: NonNullable<typeof doc> } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const headingButtons = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!open || !doc || !tab) {
      setSnapshot(null);
      return;
    }
    const id = setTimeout(() => {
      setSnapshot({ id: tab.id, doc, headings: collectHeadings(doc.toString()) });
    }, 150);
    return () => clearTimeout(id);
  }, [open, doc, tab?.id]);

  const roots = useMemo(() => tocTree(headings), [headings]);
  const filtered = useMemo(() => filterHeadings(headings, query), [headings, query]);
  const visible = useMemo(
    () => (filtered ? [] : visibleNodes(roots, collapsed)),
    [filtered, roots, collapsed],
  );
  const list = useMemo(() => filtered ?? visible.map((node) => node.heading), [filtered, visible]);
  const selected = selection?.id === tab?.id ? list.findIndex((h) => h.slug === selection?.slug) : -1;
  const ancestors = useMemo(
    () => (activeIdx >= 0 && headings[activeIdx] ? ancestorSlugs(roots, headings[activeIdx].slug) : new Set<string>()),
    [roots, headings, activeIdx],
  );

  // 스크롤 스파이 — 화면 상단+72px에 보이는 문서 위치로 현재 제목 추적.
  useEffect(() => {
    const view = store.view;
    if (!open || !view || headings.length === 0) {
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
  }, [open, store, headings]);

  // 닫힌 상태에서는 포커스가 들어가지 않게.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.inert = !open;
  }, [open]);

  // 강조 항목이 보이는 범위를 벗어나면 따라감.
  useEffect(() => {
    if (activeIdx < 0 || !bodyRef.current || bodyRef.current.contains(document.activeElement)) return;
    const el = bodyRef.current.querySelector(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const goto = (pos: number, view: EditorView | null) => {
    if (!open || !view || snapshot?.id !== store.active?.id || snapshot?.doc !== view.state.doc) return;
    store.revealLocation({ pos });
    view.focus();
  };

  const dropOn = (dstIdx: number) => {
    const d = dragHead;
    setDragHead(null);
    const view = store.view;
    if (!open || !d || !view || view.state.readOnly || store.lockedTabIds.has(d.id)) return;
    if (!snapshot || d.id !== store.active?.id || d.doc !== view.state.doc || snapshot.doc !== d.doc || snapshot.id !== d.id) {
      store.toast(t.tocMoveChanged);
      return;
    }
    const doc = view.state.doc.toString();
    const m = sectionMoveChanges(headings, d.idx, dstIdx, doc);
    if (!m) return;
    view.dispatch({
      changes: m.changes,
      selection: { anchor: m.cursor },
      annotations: isolateHistory.of("full"),
      userEvent: "input.moveSection",
      scrollIntoView: true,
    });
    view.focus();
  };

  const toggleCollapse = (slug: string) => {
    const next = new Set(store.tocCollapsed);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    store.tocCollapsed = next;
    setTick((n) => n + 1);
  };

  const focusHeading = (slug: string) => {
    const button = headingButtons.current.get(slug);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
  };

  // Move actual focus, so Enter/Space activate exactly the focused native button.
  const headingKey = (e: KeyboardEvent<HTMLButtonElement>, slug: string) => {
    if (!open || imeComposing(e) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const index = list.findIndex((h) => h.slug === slug);
    if (index < 0) return;
    let next = index;
    if (e.key === "ArrowDown") next = Math.min(list.length - 1, index + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, index - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Escape") searchRef.current?.focus();
    else if (filtered === null && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const node = visible[index];
      if (e.key === "ArrowRight") {
        if (node.children.length && collapsed.has(slug)) toggleCollapse(slug);
        else if (node.children.length) next = index + 1;
      } else if (node.children.length && !collapsed.has(slug)) toggleCollapse(slug);
      else {
        for (let i = index - 1; i >= 0; i--) if (visible[i].depth < node.depth) { next = i; break; }
      }
    } else return;
    e.preventDefault(); e.stopPropagation();
    if (e.key !== "Escape") focusHeading(list[next].slug);
  };
  const headingProps = (h: Heading) => ({
    ref: (button: HTMLButtonElement | null) => {
      if (button) headingButtons.current.set(h.slug, button);
      else headingButtons.current.delete(h.slug);
    },
    tabIndex: list[Math.max(0, selected)]?.slug === h.slug ? 0 : -1,
    onFocus: () => { if (tab) setSelection({ id: tab.id, slug: h.slug }); },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => headingKey(e, h.slug),
    onClick: () => goto(h.pos, store.view),
    "aria-current": headings[activeIdx]?.slug === h.slug ? "location" as const : undefined,
  });

  // 헤더 배지 — 제목·책갈피 수.
  const bookmarks = open && tab ? store.bookmarkLinesFor(tab) : [];
  const bookmarkCount = bookmarks.length;

  const renderNode = (node: (typeof roots)[number]) => {
    const h = node.heading;
    const isActive = node.idx === activeIdx;
    const isAncestor = ancestors.has(h.slug);
    const hasKids = node.children.length > 0;
    const isCollapsed = collapsed.has(h.slug);
    const isSel = selected >= 0 && list[selected] === h;
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
      <div
        key={`${h.slug}-${node.idx}`}
        className={`toc-row ${dragHead?.over === node.idx ? "is-drop" : ""}`}
        data-idx={node.idx}
        data-d={node.depth}
        draggable={h.movable !== false && !!store.view && !store.view.state.readOnly && !!tab && !store.lockedTabIds.has(tab.id)}
        onDragStart={(e) => {
          if (!tab || !doc || h.movable === false || store.view?.state.readOnly || store.lockedTabIds.has(tab.id) ||
              store.active?.id !== tab.id || store.view?.state.doc !== doc) { e.preventDefault(); return; }
          setDragHead({ idx: node.idx, over: -1, id: tab.id, doc });
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", h.slug);
        }}
        onDragOver={(e) => {
          if (h.movable === false || !dragHead || store.view?.state.readOnly) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          if (dragHead && dragHead.over !== node.idx) setDragHead({ ...dragHead, over: node.idx });
        }}
        onDragEnd={() => setDragHead(null)}
        onDrop={(e) => {
          e.preventDefault();
          dropOn(node.idx);
        }}
      >
        {hasKids ? (
          <button
            className={`toc-chevron ${isCollapsed ? "is-collapsed" : ""}`}
            tabIndex={-1}
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? t.tocExpand : t.tocCollapse}: ${h.text}`}
            title={isCollapsed ? t.tocExpand : t.tocCollapse}
            onClick={() => { toggleCollapse(h.slug); focusHeading(h.slug); }}
          >
            ▸
          </button>
        ) : (
          <span className="toc-chevron toc-chevron-none" />
        )}
        <button {...headingProps(h)} className={cls} aria-expanded={hasKids ? !isCollapsed : undefined}
          style={{ "--d": node.depth } as React.CSSProperties}>
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
        {tab && (
          <input
            ref={searchRef}
            className="toc-search"
            placeholder={t.tocFilter}
            aria-label={t.tocFilter}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelection(null);
            }}
            onKeyDown={(e) => {
              if (!open || imeComposing(e) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault(); e.stopPropagation();
                const h = list[selected >= 0 ? selected : e.key === "ArrowDown" ? 0 : list.length - 1];
                if (h) focusHeading(h.slug);
              } else if (e.key === "Enter") {
                e.preventDefault(); e.stopPropagation();
                const h = list[Math.max(0, selected)];
                if (h) goto(h.pos, store.view);
              } else if (e.key === "Escape") {
                e.preventDefault(); e.stopPropagation();
                setQuery(""); setSelection(null);
              }
            }}
          />
        )}
        <nav className="toc-body" aria-label={t.tocTitle}>
          {tab?.path && (bookmarkCount > 0 || tab.bookmarksLoading || tab.bookmarksBusy || tab.bookmarksError) && (
            <div className="toc-bookmarks" onKeyDown={(e) => e.stopPropagation()}>
              <div className="sidebar-subtitle">★ {t.bookmarksSection}</div>
              {(tab.bookmarksLoading || tab.bookmarksBusy) && <div role="status" className="toc-empty">{tab.bookmarksBusy ? t.bookmarksSaving : t.loading}</div>}
              {tab.bookmarksError && <div className="toc-empty" role="alert">
                <p>{t.bookmarksSyncFailed}: {tab.bookmarksError}</p>
                <button disabled={tab.bookmarksBusy || tab.bookmarksLoading} onClick={() => void store.retryBookmarks(tab.id)}>{t.bookmarksRetry}</button>
              </div>}
              {bookmarks.map((line) => (
                <button key={line} className="toc-item toc-bookmark-item" onClick={() => store.gotoBookmark(line)}>
                  <span className="toc-bm-line">{line}</span>
                  <span className="toc-text">
                    {(doc ? doc.line(Math.max(1, Math.min(line, doc.lines))).text.slice(0, 24) : "") || "—"}
                  </span>
                </button>
              ))}
            </div>
          )}
          {headings.length === 0 && <div className="toc-empty" role="status">{doc && !ready ? t.loading : t.tocEmpty}</div>}
          {filtered !== null
            ? filtered.map((h, i) => (
                <button
                  key={`${h.slug}-f${i}`}
                  {...headingProps(h)}
                  className={`toc-item toc-l${h.level} ${i === selected ? "is-sel" : ""}`}
                  style={{ "--d": Math.max(0, h.level - 1) } as React.CSSProperties}
                >
                  <span className="toc-text">{h.text || "—"}</span>
                </button>
              ))
            : visible.map((n) => renderNode(n))}
          {headings.length > 0 && filtered !== null && filtered.length === 0 && (
            <div className="toc-empty toc-empty-filter" role="status">{t.tocNoMatches}</div>
          )}
        </nav>
      </div>
    </div>
  );
}
