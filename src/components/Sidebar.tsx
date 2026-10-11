// 폴더 사이드바 — 트리, 최근 문서, 폴더 열기/닫기(M07).
// 열고 닫을 때 언마운트하지 않고 너비 애니메이션으로 부드럽게 슬라이드한다.
// 리사이즈 드래그는 React를 거치지 않고 DOM 스타일을 직접 쓴다(프레임마다
// 조정 렌더가 없음) — 놓을 때만 스토어에 확정 반영.

import { useEffect, useRef, useState } from "react";

import { isInApp, pickOpenFolder, type TreeNode } from "../api";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  tree: TreeNode[];
  workspace: string | null;
  activePath: string | null;
  t: Translate;
  open: boolean;
}

export function Sidebar({ store, tree, workspace, activePath, t, open }: Props): JSX.Element {
  const state = store.getSnapshot();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const resizing = useRef<{ startX: number; startW: number } | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const pendingW = useRef(0);

  useEffect(() => {
    const applyWidth = (w: number) => {
      // 드래그 중엔 DOM에 직접 쓴다 — React 재조정·중복 레이아웃 없이 60fps.
      pendingW.current = w;
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const pw = pendingW.current;
        if (outerRef.current) outerRef.current.style.width = `${pw}px`;
        if (innerRef.current) innerRef.current.style.width = `${pw}px`;
      });
    };
    const move = (e: MouseEvent) => {
      if (!resizing.current) return;
      const w = Math.min(420, Math.max(160, resizing.current.startW + e.clientX - resizing.current.startX));
      applyWidth(w);
    };
    const up = () => {
      if (resizing.current && pendingW.current > 0) {
        // 놓았을 때만 스토어에 확정 — 렌더 한 번으로 끝낸다.
        store.setSidebarWidth(Math.round(pendingW.current));
      }
      resizing.current = null;
      document.body.classList.remove("resizing");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  // 닫힌 상태에서는 포커스·클릭이 안 들어가게(접힌 내용은 접근성 트리에서도 제외).
  useEffect(() => {
    if (innerRef.current) innerRef.current.inert = !open;
  }, [open]);

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
  };

  const width = state.sidebarWidth;

  return (
    <div
      ref={outerRef}
      className={`sidebar ${open ? "is-open" : ""}`}
      style={{ width: open ? width : 0 }}
      aria-hidden={!open}
    >
      <div ref={innerRef} className="sidebar-fixed" style={{ width }}>
        <div className="sidebar-head">
          <span className="sidebar-title">{t.sidebarTitle}</span>
          <div className="sidebar-actions">
            {workspace && (
              <button title={t.closeFolder} onClick={() => store.closeWorkspace()}>
                ✕
              </button>
            )}
            {isInApp() && (
              <button
                title={t.openFolder}
                onClick={() => void pickOpenFolder().then((d) => { if (d) void store.openWorkspace(d); })}
              >
                ＋
              </button>
            )}
          </div>
        </div>
        <div className="sidebar-body">
          {workspace ? (
            <div className="sidebar-tree">
              {tree.map((n) => (
                <TreeNodeRow
                  key={n.path}
                  node={n}
                  depth={0}
                  activePath={activePath}
                  collapsed={collapsed}
                  onToggle={toggle}
                  store={store}
                />
              ))}
              {tree.length === 0 && <div className="sidebar-empty">{t.emptyNoDocHint}</div>}
            </div>
          ) : (
            <div className="sidebar-empty">{t.emptyNoDocHint}</div>
          )}
          {state.recent.length > 0 && (
            <div className="sidebar-recent">
              <div className="sidebar-subtitle">{t.recentSection}</div>
              {state.recent.slice(0, 8).map((r) => (
                <button
                  key={r.path}
                  className={`sidebar-recent-item ${r.path === activePath ? "is-active" : ""}`}
                  title={r.path}
                  onClick={() => void store.openPath(r.path)}
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div
          className="sidebar-resizer"
          onMouseDown={(e) => {
            resizing.current = { startX: e.clientX, startW: width };
            document.body.classList.add("resizing");
          }}
        />
      </div>
    </div>
  );
}

interface RowProps {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
  store: AppStore;
}

function TreeNodeRow({ node, depth, activePath, collapsed, onToggle, store }: RowProps): JSX.Element {
  if (node.kind === "dir") {
    const open = !collapsed.has(node.path);
    return (
      <div>
        <button
          className="tree-row tree-dir"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => onToggle(node.path)}
        >
          <span className={`tree-arrow ${open ? "tree-arrow-open" : ""}`}>▸</span>
          <span className="tree-name">{node.name}</span>
        </button>
        {open &&
          node.children?.map((c) => (
            <TreeNodeRow
              key={c.path}
              node={c}
              depth={depth + 1}
              activePath={activePath}
              collapsed={collapsed}
              onToggle={onToggle}
              store={store}
            />
          ))}
      </div>
    );
  }
  const active = node.path === activePath;
  return (
    <button
      className={`tree-row tree-file ${active ? "is-active" : ""}`}
      style={{ paddingLeft: 8 + depth * 14 + 14 }}
      title={node.path}
      onClick={() => void store.openPath(node.path)}
    >
      <span className="tree-name">{node.stem ?? node.name}</span>
    </button>
  );
}
