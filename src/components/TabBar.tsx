// 탭 막대 — 열기·닫기·드래그 순서 변경·dirty 점(M06).

import { useEffect, useState } from "react";

import { api, isInApp } from "../api";
import type { AppStore, Tab } from "../app/store";
import type { Translate } from "../i18n";

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

export function TabBar({ store, t, onClose, onCloseOthers, onCloseRight, onPin, onLock }: Props): JSX.Element {
  const state = store.getSnapshot();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; tab: Tab } | null>(null);

  // 메뉴가 열려 있을 때만 리스너 — 바깥 포인터 다운·Esc로 닫는다(사이드바 파일
  // 메뉴와 같은 규약. 메뉴 안의 클릭은 항목이 처리하므로 제외).
  useEffect(() => {
    if (!ctx) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest?.(".tab-ctx")) setCtx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctx]);

  const closeCtx = () => setCtx(null);

  return (
    <div className="tabbar">
      <div
        onWheel={(e) => {
          // 탭 바에서 휠 — 탭 순회(브라우저 관례).
          if (Math.abs(e.deltaY) < 8) return;
          e.preventDefault();
          store.cycleTabs(e.deltaY > 0);
        }}
        className="tabbar-tabs"
        onDragOver={(e) => {
          e.preventDefault();
          if (dragIdx !== null) e.dataTransfer.dropEffect = "move";
        }}
      >
        {state.tabs.map((tab, i) => {
          const dirty = tab.dirty;
          const active = tab.id === state.activeId;
          return (
            <div
              key={tab.id}
              className={`tab ${active ? "tab-active" : ""} ${tab.conflict ? "tab-conflict" : ""}`}
              draggable
              onDragStart={(e) => {
                setDragIdx(i);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDragIdx(null)}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIdx !== null && dragIdx !== i) store.moveTab(dragIdx, i);
                setDragIdx(null);
              }}
              onClick={() => store.activate(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(tab); // 중간 클릭 닫기
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtx({ x: e.clientX, y: e.clientY, tab });
              }}
              title={tab.path ?? t.untitled}
            >
              <span className="tab-mark">{store.lockedTabIds.has(tab.id) ? "🔒" : modeMark(tab.mode)}</span>
              <span className="tab-title">{tab.path ? tab.title : t.untitled}</span>
              <span className={`tab-dot ${dirty ? "tab-dot-dirty" : ""}`} title={t.dirtyTitle} />
              <button
                className="tab-newwin"
                aria-label={t.tbNewWindow}
                title={t.tbNewWindow}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tab.path && isInApp()) void api.openInNewWindow(tab.path);
                }}
              >
                ⤢
              </button>
              <button
                className="tab-close"
                aria-label={t.closeTab}
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
        <button
          className="tab-new"
          aria-label={t.newTab}
          title={t.newTab}
          onClick={() => store.newTab()}
        >
          +
        </button>
      </div>
      {ctx && (
        <div
          className="ctx-menu tab-ctx"
          // 화면 오른쪽/아래로 넘치지 않게(에디터 우클릭 메뉴와 같은 클램프).
          style={{
            left: Math.min(ctx.x, window.innerWidth - 230),
            top: Math.min(ctx.y, window.innerHeight - 230),
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button className="ctx-item" onClick={() => { onClose(ctx.tab); closeCtx(); }}>
            {t.closeTab}
          </button>
          {ctx.tab.path && isInApp() && (
            <button
              className="ctx-item"
              onClick={() => {
                void api.revealInFinder(ctx.tab.path!);
                closeCtx();
              }}
            >
              {t.tabReveal}
            </button>
          )}
          {onCloseOthers && state.tabs.length > 1 && (
            <button
              className="ctx-item"
              onClick={() => {
                onCloseOthers(ctx.tab);
                closeCtx();
              }}
            >
              {t.tabCloseOthers}
            </button>
          )}
          {onLock && (
            <button className="ctx-item" onClick={() => { onLock(ctx.tab); closeCtx(); }}>
              {store.lockedTabIds.has(ctx.tab.id) ? t.tabUnlock : t.tabLock}
            </button>
          )}
          {onPin && ctx.tab.path && (
            <button className="ctx-item" onClick={() => { onPin(ctx.tab); closeCtx(); }}>
              {t.tabPin}
            </button>
          )}
          {onCloseRight && ctx.tab.id !== state.tabs[state.tabs.length - 1]?.id && (
            <button
              className="ctx-item"
              onClick={() => {
                onCloseRight(ctx.tab);
                closeCtx();
              }}
            >
              {t.tabCloseRight}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function modeMark(mode: Tab["mode"]): string {
  return mode === "read" ? "◐" : mode === "source" ? "⌨" : "✎";
}
