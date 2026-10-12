// 탭 막대 — 열기·닫기·드래그 순서 변경·dirty 점(M06).

import { useRef, useState } from "react";

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
}

export function TabBar({ store, t, onClose, onCloseOthers, onCloseRight }: Props): JSX.Element {
  const state = store.getSnapshot();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; tab: Tab } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // 바깥 클릭·Esc로 탭 메뉴 닫기.
  const closeCtx = () => setCtx(null);

  return (
    <div
      className="tabbar"
      ref={barRef}
      onPointerDown={(e) => {
        if (ctx && !(e.target as HTMLElement).closest(".tab-ctx")) closeCtx();
      }}
    >
      <div
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
              <span className="tab-mark">{modeMark(tab.mode)}</span>
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
          style={{ left: ctx.x, top: ctx.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button className="ctx-item" onClick={() => { onClose(ctx.tab); closeCtx(); }}>
            {t.closeTab}
          </button>
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
