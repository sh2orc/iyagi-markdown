// 폴더 사이드바 — 트리, 최근 문서, 폴더 열기/닫기(M07).
// 열고 닫을 때 언마운트하지 않고 너비 애니메이션으로 부드럽게 슬라이드한다.
// 리사이즈 드래그는 React를 거치지 않고 DOM 스타일을 직접 쓴다(프레임마다
// 조정 렌더가 없음) — 놓을 때만 스토어에 확정 반영.

import { memo, useCallback, useEffect, useRef, useState } from "react";

import { api, isInApp, pickOpenFolder, type TreeNode } from "../api";
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
  const [fileCtx, setFileCtx] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);

  const runFileOp = (op: "new" | "dup" | "reveal") => {
    const ctx = fileCtx;
    setFileCtx(null);
    if (!ctx) return;
    void (async () => {
      try {
        if (op === "new") {
          if (!ctx.isDir) return;
          const p = await api.newFileIn(ctx.path);
          void store.openPath(p);
        } else if (op === "dup") {
          if (ctx.isDir) return;
          const p = await api.fileDuplicate(ctx.path);
          void store.openPath(p);
        } else {
          await api.revealInFinder(ctx.path);
        }
      } catch (e) {
        store.toast(e instanceof Error ? e.message : String(e), "error");
      }
    })();
  };

  // 메뉴 바깥 포인터 다운이면 닫기(메뉴 자체는 제외).
  useEffect(() => {
    if (!fileCtx) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".file-ctx")) setFileCtx(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [fileCtx]);

  const doRename = async (next: string) => {
    const r = renaming;
    setRenaming(null);
    if (!r || !next.trim()) return;
    const dir = r.path.substring(0, r.path.lastIndexOf("/")) || "/";
    const to = `${dir}/${next.trim().replace(/[/\\?%*:|"<>.]/g, "-")}.md`;
    if (to === r.path) return;
    try {
      await api.fileRename(r.path, to);
      // 열린 탭이면 새 경로로 다시 열기(간단 정책 — watcher가 트리 갱신).
      const open = store.state.tabs.find((x) => x.path === r.path);
      if (open) {
        store.closeTab(open.id);
        void store.openPath(to);
      }
      // 위키링크 전파 — [[옛이름]]을 새 이름으로(워크스페이스 있을 때만).
      if (store.state.workspace) {
        const oldStem = r.path.split("/").pop()?.replace(/\.md$/i, "") ?? "";
        const newStem = next.trim().replace(/[/\\?%*:|"<>.]/g, "-");
        if (oldStem && newStem && oldStem !== newStem) {
          const n = await api.updateWikiLinks(store.state.workspace, oldStem, newStem);
          if (n > 0) store.toast(t.f.wikiLinksUpdated(n));
        }
      }
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

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

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

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
                  onFileContext={(e, path, isDir) => {
                    e.preventDefault();
                    setFileCtx({ x: e.clientX, y: e.clientY, path, isDir });
                  }}
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
      {fileCtx && (
        <div
          className="ctx-menu file-ctx"
          style={{ left: fileCtx.x, top: fileCtx.y }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => {
            if (!(e.target as HTMLElement).closest(".file-ctx")) setFileCtx(null);
          }}
        >
          {fileCtx.isDir && (
            <button className="ctx-item" onClick={() => runFileOp("new")}>
              {t.ctxNewFile}
            </button>
          )}
          {!fileCtx.isDir && (
            <>
              <button
                className="ctx-item"
                onClick={() => {
                  const p = fileCtx.path;
                  setFileCtx(null);
                  setRenaming({ path: p, name: p.split("/").pop()?.replace(/\.md$/i, "") ?? "" });
                }}
              >
                {t.ctxRename}
              </button>
              <button className="ctx-item" onClick={() => runFileOp("dup")}>
                {t.ctxDuplicate}
              </button>
            </>
          )}
          <button className="ctx-item" onClick={() => runFileOp("reveal")}>
            {t.tabReveal}
          </button>
        </div>
      )}
      {renaming && (
        <div
          className="overlay modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.target === e.currentTarget && setRenaming(null)}
        >
          <div className="modal rename-dialog">
            <div className="modal-title">{t.ctxRename}</div>
            <input
              className="palette-input"
              autoFocus
              value={renaming.name}
              onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void doRename(renaming.name);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setRenaming(null);
                }
              }}
            />
            <div className="modal-actions">
              <button className="btn btn-primary" disabled={!renaming.name.trim()} onClick={() => void doRename(renaming.name)}>
                {t.save}
              </button>
              <button className="btn btn-plain" onClick={() => setRenaming(null)}>
                {t.cancel}
              </button>
            </div>
          </div>
        </div>
      )}
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
  onFileContext?: (e: React.MouseEvent, path: string, isDir: boolean) => void;
}

/** 트리 행 — memo: 스토어 emit(타이핑 등)마다 App이 다시 그려져도 props가
 *  같은 행은 재조정을 건너뛴다. 대형 워크스페이스에서 프레임을 지킨다. */
const TreeNodeRow = memo(function TreeNodeRow({
  node,
  depth,
  activePath,
  collapsed,
  onToggle,
  store,
  onFileContext,
}: RowProps): JSX.Element {
  if (node.kind === "dir") {
    const open = !collapsed.has(node.path);
    // 접힘 배지 — 안에 있는 문서 수(재귀). 목차 패널과 같은 관례.
    const fileCount = countFiles(node);
    return (
      <div className={depth === 0 ? "" : "tree-children"}>
        <button
          className="tree-row tree-dir"
          onClick={() => onToggle(node.path)}
          onContextMenu={(e) => onFileContext?.(e, node.path, true)}
        >
          <span className={`tree-arrow ${open ? "tree-arrow-open" : ""}`}>▸</span>
          <span className="tree-name">{node.name}</span>
          {!open && fileCount > 0 && <span className="tree-fold-badge">{fileCount}</span>}
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
              onFileContext={onFileContext}
            />
          ))}
      </div>
    );
  }
  const active = node.path === activePath;
  return (
    <button
      className={`tree-row tree-file ${active ? "is-active" : ""}`}
      title={node.path}
      onClick={() => void store.openPath(node.path)}
      onContextMenu={(e) => onFileContext?.(e, node.path, false)}
    >
      <span className="tree-name">{node.stem ?? node.name}</span>
    </button>
  );
});

/** 폴더 안 문서 수(재귀) — 접힘 배지용. */
function countFiles(node: TreeNode): number {
  if (node.kind === "file") return 1;
  return (node.children ?? []).reduce((acc, c) => acc + countFiles(c), 0);
}
