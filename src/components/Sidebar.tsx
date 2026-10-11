// 폴더 사이드바 — 트리, 최근 문서, 폴더 열기/닫기(M07).

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
}

export function Sidebar({ store, tree, workspace, activePath, t }: Props): JSX.Element {
  const state = store.getSnapshot();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const resizing = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!resizing.current) return;
      const w = Math.min(420, Math.max(160, resizing.current.startW + e.clientX - resizing.current.startX));
      store.setSidebarWidth(w);
    };
    const up = () => {
      resizing.current = null;
      document.body.classList.remove("resizing");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [store]);

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
  };

  return (
    <aside className="sidebar" style={{ width: state.sidebarWidth }}>
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
          resizing.current = { startX: e.clientX, startW: state.sidebarWidth };
          document.body.classList.add("resizing");
        }}
      />
    </aside>
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
