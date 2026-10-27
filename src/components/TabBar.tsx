// 탭 막대 — 열기·닫기·드래그 순서 변경·dirty 점(M06).

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { api, isInApp } from "../api";
import type { AppStore, Tab } from "../app/store";
import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: (tab: Tab) => void;
  /** 다른 탭 전부 닫기·오른쪽 탭 닫기(App이 더티 확인을 한 번에). */
  onCloseOthers?: (tab: Tab) => void;
  onCloseRight?: (tab: Tab) => void;
  /** 참조 보기 토글 — 옆에 고정(읽기 전용). */
  onPin?: (tab: Tab) => void;
  /** 읽기 전용 잠금 토글. */
  onLock?: (tab: Tab) => void;
}

export const documentTabId = (id: string) => `document-tab-${id}`;

export function TabBar({ store, t, onClose, onCloseOthers, onCloseRight, onPin, onLock }: Props): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [dragId, setDragId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const newRef = useRef<HTMLButtonElement | null>(null);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastFocus = useRef<{ id: string } | null>(null);
  const tabIds = state.tabs.map((tab) => tab.id).join(" ");
  const tabStop = state.tabs.some((tab) => tab.id === focusId) ? focusId : state.activeId ?? state.tabs[0]?.id;
  const contextTab = ctx ? state.tabs.find((tab) => tab.id === ctx.id) : undefined;
  const focusTab = (id: string | null) => {
    const button = id ? tabButtons.current.get(id) : null;
    (button ?? newRef.current)?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const closeCtx = (restore = true) => {
    setCtx(null);
    if (restore) focusTab(ctx?.id ?? store.state.activeId);
  };
  const runContext = (run: (tab: Tab) => void) => {
    const tab = store.state.tabs.find((item) => item.id === ctx?.id);
    closeCtx();
    if (tab) run(tab);
  };
  const moveById = (id: string, target: string | null) => {
    const tabs = store.state.tabs;
    const from = tabs.findIndex((tab) => tab.id === id);
    const to = target === null ? tabs.length - 1 : tabs.findIndex((tab) => tab.id === target);
    if (from >= 0 && to >= 0) store.moveTab(from, to);
  };
  const openWindow = (tab: Tab) => {
    if (tab.path && isInApp()) void api.openInNewWindow(tab.path)
      .catch((error) => store.toast(`${t.tabActionFailed}: ${String(error)}`, "error"));
  };

  useLayoutEffect(() => {
    const previous = lastFocus.current;
    if (previous && !state.tabs.some((tab) => tab.id === previous.id)) {
      lastFocus.current = null;
      if (document.activeElement === document.body || !document.activeElement?.isConnected) focusTab(state.activeId);
    }
    if (ctx && !contextTab) closeCtx(false);
  }, [tabIds, ctx, contextTab]);

  useEffect(() => {
    setFocusId(state.activeId);
    if (state.activeId) tabButtons.current.get(state.activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state.activeId]);

  useLayoutEffect(() => {
    if (!ctx || !menuRef.current) return;
    const menu = menuRef.current;
    // offset sizes exclude the opening scale animation.
    menu.style.left = `${Math.max(0, Math.min(ctx.x, window.innerWidth - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(0, Math.min(ctx.y, window.innerHeight - menu.offsetHeight))}px`;
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [ctx]);

  // Scroll overflowing tabs without activating documents on a trackpad gesture.
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1);
      const next = Math.max(0, Math.min(max, el.scrollLeft + delta));
      if (max <= 0 || next === el.scrollLeft) return;
      e.preventDefault(); el.scrollLeft = next;
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, [store]);

  // 메뉴가 열려 있을 때만 리스너 — 바깥 포인터 다운·Esc로 닫는다(사이드바 파일
  // 메뉴와 같은 규약. 메뉴 안의 클릭은 항목이 처리하므로 제외).
  useEffect(() => {
    if (!ctx) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".tab-ctx")) setCtx(null);
    };
    const dismiss = () => setCtx(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [ctx]);

  const pathTotals = new Map<string, number>();
  const pathOrdinals = new Map<string, number>();
  for (const tab of state.tabs) {
    if (tab.path) pathTotals.set(tab.path, (pathTotals.get(tab.path) ?? 0) + 1);
  }

  return (
    <div className="tabbar">
      <div className="tab-history" role="group" aria-label={t.navigationHistory}>
        <button aria-label={t.navigateBack} title={`${t.navigateBack} (⌥⌘←)`}
          disabled={!store.canNavigateBack || !!state.busy} onClick={() => store.navigateHistory(false)}>←</button>
        <button aria-label={t.navigateForward} title={`${t.navigateForward} (⌥⌘→)`}
          disabled={!store.canNavigateForward || !!state.busy} onClick={() => store.navigateHistory(true)}>→</button>
        <button aria-label={t.reopenClosedTab} title={`${t.reopenClosedTab} (⇧⌘T)`}
          disabled={!store.canReopenClosedTab || !!state.busy} onClick={() => void store.reopenClosedTab()}>↶</button>
      </div>
      <div
        ref={tabsRef}
        className="tabbar-tabs"
        role="tablist"
        aria-label={t.openTabs}
        onDragOver={(e) => {
          if (dragId !== null) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
        }}
        onDrop={(e) => {
          // 탭이 아닌 곳(끝의 빈 공간·+ 버튼)에 놓으면 맨 끝으로 — 브라우저 관례.
          // 탭 위 드롭은 각 탭의 onDrop이 먼저 처리하고 여기로 버블링되므로
          // closest 가드로 걸러낸다(이중 이동 방지).
          if (dragId === null) return;
          e.preventDefault();
          if ((e.target as HTMLElement).closest?.(".tab")) return;
          moveById(dragId, null);
          setDragId(null);
        }}
      >
        {state.tabs.map((tab) => {
          const dirty = tab.dirty;
          const active = tab.id === state.activeId;
          const ordinal = tab.path ? (pathOrdinals.get(tab.path) ?? 0) + 1 : 1;
          if (tab.path) pathOrdinals.set(tab.path, ordinal);
          const suffix = tab.path && (pathTotals.get(tab.path) ?? 0) > 1
            ? ` (${ordinal}/${pathTotals.get(tab.path)})` : "";
          return (
            <div
              key={tab.id}
              role="presentation"
              className={`tab ${active ? "tab-active" : ""} ${tab.conflict ? "tab-conflict" : ""}`}
              draggable
              onDragStart={(e) => {
                if ((e.target as HTMLElement).closest(".tab-close, .tab-newwin")) { e.preventDefault(); return; }
                setDragId(tab.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragEnd={() => setDragId(null)}
              onDrop={(e) => {
                if (dragId === null) return;
                e.preventDefault(); e.stopPropagation();
                moveById(dragId, tab.id);
                setDragId(null);
              }}
              onFocusCapture={() => { lastFocus.current = { id: tab.id }; }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button")) return;
                focusTab(tab.id);
                if (store.active?.id !== tab.id) store.activate(tab.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(tab); // 중간 클릭 닫기
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setCtx({ x: e.clientX || rect.left, y: e.clientY || rect.bottom, id: tab.id });
              }}
              title={`${tab.path ?? t.untitled}${suffix}`}
            >
              <button className="tab-select" role="tab" id={documentTabId(tab.id)} aria-selected={active}
                aria-controls="active-document-panel"
                aria-label={`${tab.path ? tab.title : t.untitled}${suffix}${dirty ? ` · ${t.dirtyTitle}` : ""}${store.lockedTabIds.has(tab.id) ? ` · ${t.tabLock}` : ""}`}
                tabIndex={tabStop === tab.id ? 0 : -1}
                ref={(button) => { if (button) tabButtons.current.set(tab.id, button); else tabButtons.current.delete(tab.id); }}
                onFocus={() => setFocusId(tab.id)}
                onClick={() => { if (store.active?.id !== tab.id) store.activate(tab.id); }}
                onKeyDown={(e) => {
                  if (imeComposing(e)) return;
                  if (e.key === "ContextMenu" || e.key === "F10" && e.shiftKey) {
                    e.preventDefault(); e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setCtx({ x: rect.left, y: rect.bottom, id: tab.id }); return;
                  }
                  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
                  const tabs = store.state.tabs, index = tabs.findIndex((item) => item.id === tab.id);
                  if (index < 0) return;
                  let next: number;
                  if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
                  else if (e.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
                  else if (e.key === "Home") next = 0;
                  else if (e.key === "End") next = tabs.length - 1;
                  else if (e.key === "Delete") { e.preventDefault(); e.stopPropagation(); if (!e.repeat) onClose(tab); return; }
                  else return;
                  e.preventDefault(); e.stopPropagation(); focusTab(tabs[next].id);
                }}>
                <span className="tab-mark" aria-hidden="true">{store.lockedTabIds.has(tab.id) ? "🔒" : modeMark(tab.mode)}</span>
                <span className="tab-title">{tab.path ? tab.title : t.untitled}{suffix}</span>
                <span aria-hidden="true" className={`tab-dot ${dirty ? "tab-dot-dirty" : ""}`} title={t.dirtyTitle} />
              </button>
              <button
                className="tab-newwin"
                aria-label={t.tbNewWindow}
                title={t.tbNewWindow}
                disabled={!tab.path || !isInApp()}
                tabIndex={active ? 0 : -1}
                onClick={(e) => {
                  e.stopPropagation();
                  openWindow(tab);
                }}
              >
                ⤢
              </button>
              <button
                className="tab-close"
                aria-label={t.closeTab}
                tabIndex={active ? 0 : -1}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
        <button
          ref={newRef}
          className="tab-new"
          aria-label={t.newTab}
          title={t.newTab}
          onDragOver={(e) => { if (dragId !== null) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
          onDrop={(e) => {
            if (dragId === null) return;
            e.preventDefault(); moveById(dragId, null); setDragId(null);
          }}
          onClick={() => store.newTab()}
        >
          +
        </button>
      {ctx && contextTab && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${t.tabMenu}: ${contextTab.path ? contextTab.title : t.untitled}`}
          className="ctx-menu tab-ctx"
          // 화면 오른쪽/아래로 넘치지 않게(에디터 우클릭 메뉴와 같은 클램프).
          style={{
            left: ctx.x,
            top: ctx.y,
          }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (imeComposing(e)) return;
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCtx(); return; }
            if (e.key === "Tab") { closeCtx(); return; }
            if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
            const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            let next: number;
            if (e.key === "ArrowDown") next = (index + 1) % items.length;
            else if (e.key === "ArrowUp") next = index < 0 ? items.length - 1 : (index + items.length - 1) % items.length;
            else if (e.key === "Home") next = 0;
            else if (e.key === "End") next = items.length - 1;
            else return;
            e.preventDefault(); e.stopPropagation(); items[next]?.focus();
          }}
        >
          <button role="menuitem" className="ctx-item" onClick={() => runContext(onClose)}>
            {t.closeTab}
          </button>
          {contextTab.path && isInApp() && <button role="menuitem" className="ctx-item"
            disabled={!state.favoritesLoaded || state.favoritesBusy || state.favoritesLoading}
            onClick={() => runContext((tab) => { if (tab.path) void store.setFavorite(tab.path, !store.isFavorite(tab.path)); })}>
            {store.isFavorite(contextTab.path) ? t.favoriteRemove : t.favoriteAdd}
          </button>}
          {contextTab.path && isInApp() && (
            <button
              className="ctx-item"
              role="menuitem"
              onClick={() => {
                runContext((tab) => { if (tab.path) void api.revealInFinder(tab.path)
                  .catch((error) => store.toast(`${t.tabActionFailed}: ${String(error)}`, "error")); });
              }}
            >
              {t.tabReveal}
            </button>
          )}
          {onCloseOthers && state.tabs.length > 1 && (
            <button
              className="ctx-item"
              role="menuitem"
              onClick={() => {
                runContext(onCloseOthers);
              }}
            >
              {t.tabCloseOthers}
            </button>
          )}
          {onLock && (
            <button role="menuitem" className="ctx-item" onClick={() => runContext(onLock)}>
              {store.lockedTabIds.has(contextTab.id) ? t.tabUnlock : t.tabLock}
            </button>
          )}
          {onPin && contextTab.path && (
            <button role="menuitem" className="ctx-item" onClick={() => runContext(onPin)}>
              {t.tabPin}
            </button>
          )}
          {onCloseRight && contextTab.id !== state.tabs[state.tabs.length - 1]?.id && (
            <button
              className="ctx-item"
              role="menuitem"
              onClick={() => {
                runContext(onCloseRight);
              }}
            >
              {t.tabCloseRight}
            </button>
          )}
          <button role="menuitem" className="ctx-item" disabled={contextTab.id === state.tabs[0]?.id}
            onClick={() => runContext((tab) => { const i = store.state.tabs.indexOf(tab); if (i > 0) store.moveTab(i, i - 1); })}>{t.tabMoveLeft}</button>
          <button role="menuitem" className="ctx-item" disabled={contextTab.id === state.tabs.at(-1)?.id}
            onClick={() => runContext((tab) => { const i = store.state.tabs.indexOf(tab); if (i >= 0 && i < store.state.tabs.length - 1) store.moveTab(i, i + 1); })}>{t.tabMoveRight}</button>
        </div>
      )}
    </div>
  );
}

function modeMark(mode: Tab["mode"]): string {
  return mode === "read" ? "◐" : mode === "source" ? "⌨" : "✎";
}
