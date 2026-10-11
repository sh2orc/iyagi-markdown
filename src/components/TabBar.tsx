// 탭 막대 — 열기·닫기·드래그 순서 변경·dirty 점(M06).

import { useRef, useState } from "react";

import type { AppStore, Tab } from "../app/store";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: (tab: Tab) => void;
}

export function TabBar({ store, t, onClose }: Props): JSX.Element {
  const state = store.getSnapshot();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="tabbar" ref={barRef}>
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
              title={tab.path ?? t.untitled}
            >
              <span className="tab-mark">{modeMark(tab.mode)}</span>
              <span className="tab-title">{tab.path ? tab.title : t.untitled}</span>
              <span className={`tab-dot ${dirty ? "tab-dot-dirty" : ""}`} title={t.dirtyTitle} />
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
    </div>
  );
}

function modeMark(mode: Tab["mode"]): string {
  return mode === "read" ? "◐" : mode === "source" ? "⌨" : "✎";
}
