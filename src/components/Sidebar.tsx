// 폴더 사이드바 — 트리, 최근 문서, 폴더 열기/닫기(M07).
// 열고 닫을 때 언마운트하지 않고 너비 애니메이션으로 부드럽게 슬라이드한다.
// 리사이즈 드래그는 React를 거치지 않고 DOM 스타일을 직접 쓴다(프레임마다
// 조정 렌더가 없음) — 놓을 때만 스토어에 확정 반영.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { api, isInApp, onPendingRenamesChanged, pickOpenFolder, type TreeNode, type PendingRename } from "../api";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import { dirname } from "../paths";
import { RenameLinksReview, type RenamedDocument } from "./RenameLinksReview";
import { RecentDocuments } from "./RecentDocuments";
import { FavoriteDocuments } from "./FavoriteDocuments";
import { RecentWorkspaces } from "./RecentWorkspaces";
import { NewFolderDialog } from "./NewFolderDialog";
import { TrashDocumentDialog } from "./TrashDocumentDialog";
import { imeComposing } from "../app/ime";

interface Props {
  store: AppStore;
  tree: TreeNode[];
  workspace: string | null;
  activePath: string | null;
  t: Translate;
  open: boolean;
  onModalChange: (open: boolean) => void;
}

type FileOperation = { action: "new" | "dup"; source: string; root: string } & (
  { phase: "working" } | { phase: "created"; path: string } | { phase: "failed"; error: string }
);

export function Sidebar({ store, tree, workspace, activePath, t, open, onModalChange }: Props): JSX.Element {
  const [, bump] = useState(0);
  const forceUpdate = () => bump((n) => n + 1);
  const [fileCtx, setFileCtx] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; name: string; root: string | null } | null>(null);
  const [newFolder, setNewFolder] = useState<{ root: string; dir: string; returnFocus: Element | null } | null>(null);
  const [trashing, setTrashing] = useState<{ root: string; path: string; isCurrent: () => boolean } | null>(null);
  const pendingFolderFocus = useRef<{ root: string; path: string; returnFocus: Element | null; tree: TreeNode[] | null } | null>(null);

  const [query, setQuery] = useState("");
  const browsing = useRef({ workspace, query, open });
  if (browsing.current.workspace !== workspace || browsing.current.query !== query || browsing.current.open !== open) {
    browsing.current = { workspace, query, open };
  }
  const [fileOperation, setFileOperation] = useState<FileOperation | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const filterRef = useRef<HTMLInputElement>(null);
  const lastTreeFocus = useRef<{ element: HTMLElement; path: string; index: number; workspace: string | null } | null>(null);
  const typeAhead = useRef({ text: "", at: 0 });
  const [renameBusy, setRenameBusy] = useState(false);
  const renameBusyRef = useRef(false);
  const [linkReview, setLinkReview] = useState<RenamedDocument | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingJobs, setPendingJobs] = useState<PendingRename[]>([]);
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [pendingWatchError, setPendingWatchError] = useState<string | null>(null);
  const [pendingWatchVersion, setPendingWatchVersion] = useState(0);
  const [finishingJob, setFinishingJob] = useState<number | null>(null);
  const finishingRef = useRef(false);
  const pendingSequence = useRef(0);
  const alive = useRef(true);
  const reloadPending = useCallback(async (): Promise<PendingRename[] | null> => {
    if (!alive.current) return null;
    if (!isInApp()) { setPendingLoaded(true); return []; }
    const version = ++pendingSequence.current;
    setPendingLoading(true);
    try {
      const jobs = await api.pendingRenames();
      if (alive.current && pendingSequence.current === version) {
        setPendingJobs(jobs); setPendingLoaded(true); setPendingError(null);
      }
      return jobs;
    } catch (e) {
      if (alive.current && pendingSequence.current === version) setPendingError(String(e));
      return null;
    } finally {
      if (alive.current && pendingSequence.current === version) setPendingLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    setPendingWatchError(null);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void reloadPending();
    void onPendingRenamesChanged(() => { if (!disposed) void reloadPending(); }).then((stop) => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      void reloadPending(); // 구독 전 변경도 다시 읽는다.
    }).catch((e: unknown) => { if (!disposed) setPendingWatchError(String(e)); });
    return () => { disposed = true; alive.current = false; ++pendingSequence.current; unlisten?.(); };
  }, [reloadPending, pendingWatchVersion]);
  const dismissJob = async (id: number) => {
    if (finishingRef.current) return;
    finishingRef.current = true; setFinishingJob(id);
    try {
      await api.finishRenameReview(id, true);
      ++pendingSequence.current;
      if (alive.current) { setPendingJobs((jobs) => jobs.filter((job) => job.id !== id)); setPendingError(null); }
      await reloadPending();
    } catch (e) { if (alive.current) setPendingError(String(e)); }
    finally { finishingRef.current = false; if (alive.current) setFinishingJob(null); }
  };
  const [renameError, setRenameError] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const operationBusy = useRef(false);
  useEffect(() => {
    onModalChange(renaming !== null || newFolder !== null || trashing !== null || reviewOpen);
    return () => onModalChange(false);
  }, [renaming !== null, newFolder !== null, trashing !== null, reviewOpen, onModalChange]);
  useEffect(() => {
    setQuery(""); setFocusedPath(null); setFileCtx(null);
    setNewFolder(null); setTrashing(null); pendingFolderFocus.current = null;
    typeAhead.current = { text: "", at: 0 };
  }, [workspace]);

  const startFolder = (dir: string) => {
    if (!workspace || newFolder || operationBusy.current) return;
    closeFileMenu();
    setNewFolder({ root: workspace, dir, returnFocus: document.activeElement });
  };
  const folderCreated = (path: string) => {
    if (!newFolder || store.state.workspace !== newFolder.root) return;
    const request = { root: newFolder.root, path, returnFocus: newFolder.returnFocus, tree: null as TreeNode[] | null };
    pendingFolderFocus.current = request;
    setNewFolder(null); setQuery(""); setFocusedPath(path);
    const next = new Set(store.collapsedFolders);
    let parent = dirname(path);
    while (parent !== dirname(parent)) {
      next.delete(parent);
      if (parent === request.root) break;
      parent = dirname(parent);
    }
    store.collapsedFolders = next;
    store.scheduleSessionSave();
    void store.refreshTree().then(() => {
      if (!alive.current || pendingFolderFocus.current !== request) return;
      if (store.state.workspace !== request.root || store.state.workspaceError) pendingFolderFocus.current = null;
      else request.tree = store.state.tree;
      forceUpdate();
    }).catch((reason) => {
      if (pendingFolderFocus.current === request) pendingFolderFocus.current = null;
      store.toast(`${t.workspaceFailed}: ${String(reason)}`, "error");
    });
  };

  const createDocument = async (action: "new" | "dup", source: string) => {
    if (operationBusy.current || !workspace || store.state.workspace !== workspace) return;
    const context = store.beginWorkspaceFileAction();
    if (!context.root || context.root !== workspace) return;
    const request = { action, source, root: context.root };
    const originalBrowsing = browsing.current;
    const current = () => alive.current && context.isWorkspaceCurrent() && browsing.current === originalBrowsing;
    operationBusy.current = true; setFileBusy(true);
    setFileOperation({ ...request, phase: "working" });
    let path: string | null = null;
    try {
      path = action === "new" ? await api.newFileIn(source) : await api.fileDuplicate(source);
      if (alive.current) setFileOperation({ ...request, phase: "created", path });
      else store.toast(`${action === "new" ? t.fileCreated : t.fileDuplicated}: ${path}`);
      if (current()) {
        const next = new Set(store.collapsedFolders);
        next.delete(dirname(path));
        store.collapsedFolders = next;
        store.scheduleSessionSave();
      }
      if (context.isWorkspaceCurrent()) await store.refreshTree();
      if (current() && context.canNavigate()) await store.openPath(path, undefined, undefined, current);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // A created file remains a success even if listing/opening it fails. Retry
      // opening that path instead of creating a second file.
      if (path) store.toast(error, "error");
      else if (alive.current) setFileOperation({ ...request, phase: "failed", error });
      else store.toast(error, "error");
    } finally {
      operationBusy.current = false;
      if (alive.current) setFileBusy(false);
    }
  };

  const runFileOp = (op: "new" | "dup" | "reveal") => {
    const ctx = fileCtx;
    closeFileMenu();
    if (!ctx) return;
    void (async () => {
      try {
        if (op === "new") {
          if (!ctx.isDir) return;
          await createDocument("new", ctx.path);
        } else if (op === "dup") {
          if (ctx.isDir) return;
          await createDocument("dup", ctx.path);
        } else {
          await api.revealInFinder(ctx.path);
        }
      } catch (e) {
        store.toast(e instanceof Error ? e.message : String(e), "error");
      }
    })();
  };

  // 현재 파일 드러내기 — 접힌 조상을 펼치고 활성 행으로 스크롤.
  const revealActive = () => {
    if (!activePath) return;
    setQuery("");
    const parts = activePath.split("/");
    for (let i = 2; i <= parts.length; i++) {
      const dir = parts.slice(0, i - 1).join("/");
      if (dir && collapsed.has(dir)) toggle(dir);
    }
    requestAnimationFrame(() => {
      innerRef.current?.querySelector(".tree-file.is-active")?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    });
  };

  // 메뉴 바깥 포인터·창 전환에서는 새 포커스를 빼앗지 않는다.
  useEffect(() => {
    if (!fileCtx) return;
    const close = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setFileCtx(null);
    };
    const dismiss = () => setFileCtx(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, [fileCtx]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!fileCtx || !menu) return;
    menu.style.left = `${Math.max(0, Math.min(fileCtx.x, window.innerWidth - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(0, Math.min(fileCtx.y, window.innerHeight - menu.offsetHeight))}px`;
    if (!menu.contains(document.activeElement) || (document.activeElement as HTMLButtonElement).disabled) {
      menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
  }, [fileCtx, pendingLoaded, pendingLoading, pendingError, pendingJobs]);

  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest?.(".sidebar-tree") && !menuRef.current?.contains(target)) {
        lastTreeFocus.current = null;
        typeAhead.current = { text: "", at: 0 };
      }
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);

  const doRename = async (next: string) => {
    const r = renaming;
    if (!r || renameBusyRef.current) return;
    const renameRoot = r.root;
    const name = next.trim();
    if (!name || name === "." || name === ".." || /[/\\\x00-\x1f]/.test(name)) {
      setRenameError(t.renameInvalid);
      return;
    }
    const extension = /\.markdown$/i.test(r.path) ? ".markdown" : ".md";
    const filename = /\.(md|markdown)$/i.test(name) ? name : `${name}${extension}`;
    const to = `${dirname(r.path).replace(/\/$/, "")}/${filename}`;
    if (to === r.path) { setRenaming(null); return; }
    renameBusyRef.current = true;
    setRenameBusy(true);
    setRenameError("");
    try {
      if (!(await store.renameDocument(r.path, to, renameRoot))) {
        setRenameError(t.renameFailed);
        void reloadPending();
        return;
      }
      setFocusedPath(to);
      setRenaming(null);
      if (renameRoot) {
        const jobs = await reloadPending();
        const job = jobs?.find((item) => item.root === renameRoot && item.from === r.path && item.to === to);
        if (job?.ready) { setLinkReview(job); setReviewOpen(true); }
      }
    } catch (e) {
      store.toast(String(e), "error");
    } finally {
      renameBusyRef.current = false;
      setRenameBusy(false);
    }
  };

  const state = store.getSnapshot();
  // 접힘 상태는 스토어가 소유(세션 저장·복원) — 컴포넌트는 직접 조작.
  const collapsed = store.collapsedFolders;
  const setCollapsed = (next: Set<string>) => {
    store.collapsedFolders = next;
    store.scheduleSessionSave();
    forceUpdate();
  };
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
    const next = new Set(store.collapsedFolders);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
  }, [store]);

  // 하위 항목 수는 트리에만 의존한다 — 검색어·폴더 접힘 바뀔 때마다 전체
  // 순회를 반복하지 않게 별도 메모로 뗀다.
  const counts = useMemo(() => {
    const counts = new Map<string, number>();
    const count = (node: TreeNode): number => {
      const total = node.kind === "file" ? 1 : (node.children ?? []).reduce((sum, child) => sum + count(child), 0);
      counts.set(node.path, total);
      return total;
    };
    tree.forEach(count);
    return counts;
  }, [tree]);
  const rows = useMemo(() => {
    const needle = query.trim().normalize("NFC").toLocaleLowerCase();
    const result: Array<{ node: TreeNode; depth: number; parent: string | null; expanded: boolean; size: number; position: number; count: number }> = [];
    const matching = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((node) => {
      if (!needle || node.name.normalize("NFC").toLocaleLowerCase().includes(needle)) return [node];
      const children = matching(node.children ?? []);
      return children.length ? [{ ...node, children }] : [];
    });
    const visit = (nodes: TreeNode[], depth: number, parent: string | null) => {
      for (const [index, node] of nodes.entries()) {
        const expanded = !!needle || !collapsed.has(node.path);
        result.push({ node, depth, parent, expanded, size: nodes.length, position: index + 1, count: counts.get(node.path) ?? 0 });
        if (node.kind === "dir" && expanded) visit(node.children ?? [], depth + 1, node.path);
      }
    };
    visit(matching(tree), 0, null);
    return result;
  }, [tree, counts, collapsed, query]);
  const tabStop = rows.some((r) => r.node.path === focusedPath) ? focusedPath
    : rows.some((r) => r.node.path === activePath) ? activePath : rows[0]?.node.path;
  const focusRow = useCallback((path: string | undefined) => {
    if (!path) return;
    const row = rowButtons.current.get(path);
    if (!row) return;
    setFocusedPath(path);
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }, []);
  const closeFileMenu = () => {
    if (fileCtx) focusRow(fileCtx.path);
    setFileCtx(null);
  };

  useLayoutEffect(() => {
    const pending = pendingFolderFocus.current;
    if (!pending || newFolder) return;
    if (!open || workspace !== pending.root) { pendingFolderFocus.current = null; return; }
    const targetPath = rowButtons.current.has(pending.path) ? pending.path
      : rows.find((row) => row.node.path.normalize("NFC") === pending.path.normalize("NFC"))?.node.path;
    if (!targetPath) {
      if (pending.tree === tree) pendingFolderFocus.current = null;
      return;
    }
    pendingFolderFocus.current = null;
    const active = document.activeElement;
    // A later tree response must not take focus from a new editing action.
    if (active === document.body || !active?.isConnected || active === pending.returnFocus) focusRow(targetPath);
  });

  useLayoutEffect(() => {
    const previous = lastTreeFocus.current;
    const contextRemoved = fileCtx && !rows.some((row) => row.node.path === fileCtx.path);
    const menuFocused = !!menuRef.current?.contains(document.activeElement);
    if (contextRemoved || !open) setFileCtx(null);
    if (!open || !previous || previous.workspace !== workspace || previous.element.isConnected) return;
    lastTreeFocus.current = null;
    if (document.activeElement !== document.body && document.activeElement?.isConnected && !(contextRemoved && menuFocused)) return;
    let parent = dirname(previous.path);
    while (!rowButtons.current.has(parent) && parent !== dirname(parent)) parent = dirname(parent);
    const target = rowButtons.current.has(parent) ? parent : rows[Math.min(previous.index, rows.length - 1)]?.node.path;
    if (target) focusRow(target);
    else filterRef.current?.focus();
  }, [rows, open, workspace, fileCtx, focusRow]);

  // 타이핑에 따른 상위 렌더에서는 파일 행 DOM을 다시 만들지 않는다.
  const renderedRows = useMemo(() => rows.map(({ node, depth, expanded, size, position, count }, index) => (
      <button key={node.path} role="treeitem" data-tree-path={node.path}
        ref={(button) => { if (button) rowButtons.current.set(node.path, button); else rowButtons.current.delete(node.path); }}
        aria-setsize={size} aria-posinset={position}
        aria-level={depth + 1} aria-selected={node.path === activePath}
        aria-expanded={node.kind === "dir" ? expanded : undefined}
        tabIndex={node.path === tabStop ? 0 : -1}
        className={`tree-row ${node.kind === "dir" ? "tree-dir" : "tree-file"} ${node.path === activePath ? "is-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }} title={node.path}
        onFocus={(e) => {
          setFocusedPath(node.path);
          lastTreeFocus.current = { element: e.currentTarget, path: node.path, index, workspace };
        }}
        onClick={() => node.kind === "dir" ? (query.trim() ? undefined : toggle(node.path)) : void store.openPath(node.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          focusRow(node.path);
          setFileCtx({ x: e.clientX, y: e.clientY, path: node.path, isDir: node.kind === "dir" });
        }}>
        <span className={`tree-arrow ${node.kind === "dir" && expanded ? "tree-arrow-open" : ""}`} aria-hidden="true">{node.kind === "dir" ? "▸" : "·"}</span>
        <span className="tree-name">{node.stem ?? node.name}</span>
        {node.kind === "dir" && !expanded && count > 0 && <span className="tree-fold-badge">{count}</span>}
      </button>
  )), [rows, tabStop, activePath, query, toggle, store, workspace, focusRow]);

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
          <span className="sidebar-title" title={workspace ?? undefined}>{workspace?.split("/").filter(Boolean).pop() ?? t.sidebarTitle}</span>
          <div className="sidebar-actions">
            {workspace && isInApp() && (
              <button title={t.ctxNewFile} aria-label={t.ctxNewFile}
                disabled={fileBusy || !!state.workspaceError || (state.workspaceLoading && !state.workspaceTreeLoaded)}
                onClick={() => void createDocument("new", workspace)}>＋</button>
            )}
            {workspace && isInApp() && <button title={t.ctxNewFolder} aria-label={t.ctxNewFolder}
              disabled={fileBusy || !!state.workspaceError || (state.workspaceLoading && !state.workspaceTreeLoaded)}
              onClick={(event) => { event.currentTarget.focus(); startFolder(workspace); }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <path d="M3 7V5h7l2 3h9v12H3V7Z" /><path d="M12 11v6m-3-3h6" />
              </svg>
            </button>}
            {workspace && <button title={t.workspaceRefresh} aria-label={t.workspaceRefresh}
              disabled={state.workspaceLoading} onClick={() => void store.openWorkspace(workspace)}>↻</button>}
            {workspace && activePath && (
              <button title={t.sidebarRevealActive} aria-label={t.sidebarRevealActive} onClick={revealActive}>
                ⇱
              </button>
            )}
            {workspace && (
              <button title={t.closeFolder} aria-label={t.closeFolder} onClick={() => store.closeWorkspace()}>
                ✕
              </button>
            )}
            {isInApp() && (
              <button
                aria-label={t.openFolder}
                title={t.openFolder}
                onClick={() => void pickOpenFolder().then((d) => { if (d) void store.openWorkspace(d); })}
              >
                ▣
              </button>
            )}
          </div>
        </div>
        {workspace && (
          <div className="sidebar-filter">
            <input ref={filterRef} type="search" value={query} aria-label={t.sidebarFilter} placeholder={t.sidebarFilter}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (imeComposing(e) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
                if (e.key === "ArrowDown") { e.preventDefault(); focusRow(rows[0]?.node.path); }
                if (e.key === "ArrowUp") { e.preventDefault(); focusRow(rows[rows.length - 1]?.node.path); }
                if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
              }} />
          </div>
        )}
        <div className="sidebar-body">
          {fileOperation && <div className="sidebar-file-operation" aria-busy={fileBusy}>
            <p role={fileOperation.phase === "failed" ? "alert" : "status"}>
              {fileOperation.phase === "working" ? (fileOperation.action === "new" ? t.fileCreating : t.fileDuplicating)
                : fileOperation.phase === "created" ? (fileOperation.action === "new" ? t.fileCreated : t.fileDuplicated)
                : (fileOperation.action === "new" ? t.fileCreateFailed : t.fileDuplicateFailed)}
              {fileOperation.phase === "failed" && `: ${fileOperation.error}`}
            </p>
            <p className="sidebar-operation-path">{fileOperation.phase === "created" ? fileOperation.path : fileOperation.source}</p>
            <div className="sidebar-operation-actions">
              {fileOperation.phase === "created" && <button className="btn" onClick={() => {
                void store.openPath(fileOperation.path).catch((error) => store.toast(String(error), "error"));
              }}>{t.fileOperationOpen}</button>}
              {fileOperation.phase === "failed" && <button className="btn" disabled={fileBusy || workspace !== fileOperation.root}
                onClick={() => void createDocument(fileOperation.action, fileOperation.source)}>{t.wsRetry}</button>}
              {fileOperation.phase !== "working" && <button className="btn btn-plain" disabled={fileBusy} onClick={() => setFileOperation(null)}>{t.close}</button>}
            </div>
            {fileOperation.phase === "failed" && workspace !== fileOperation.root && <p>{t.fileOperationWorkspace}</p>}
          </div>}
          {(pendingJobs.length > 0 || pendingError || pendingWatchError || pendingLoading) && <div className="sidebar-rename-pending">
            {pendingLoading && <p role="status">{t.renameJobsLoading}</p>}
            {(pendingError || pendingWatchError) && <div role="alert">
              <p>{t.renameJobsLoadFailed}: {pendingError ?? pendingWatchError}</p>
              <button className="btn" disabled={pendingLoading} onClick={() => { if (pendingWatchError) setPendingWatchVersion((n) => n + 1); else void reloadPending(); }}>{t.wsRetry}</button>
            </div>}
            {pendingJobs.map((job) => <div key={job.id}>
              <p>{t.renameLinksPending}</p>
              <p className="rename-links-path">{job.from} → {job.to}</p>
              {!job.ready && <p role="alert">{t.renameJobsInterrupted}: {job.error}</p>}
              <button className="btn" disabled={!job.ready || reviewOpen || finishingJob !== null}
                onClick={() => { setLinkReview(job); setReviewOpen(true); }}>{t.renameLinksReview}</button>
              <button className="btn btn-plain" disabled={finishingJob !== null || reviewOpen}
                onClick={() => void dismissJob(job.id)}>{finishingJob === job.id ? t.loading : t.renameLinksSkip}</button>
            </div>)}
          </div>}

          <FavoriteDocuments store={store} t={t} query={query} />
          <RecentWorkspaces store={store} t={t} query={query} />
          {workspace && <div className="workspace-status">
            {state.workspaceLoading && <p role="status">{t.workspaceLoading}</p>}
            {state.workspaceError && <div role="alert">
              <p>{t.workspaceFailed}</p>
              <p>{state.workspaceError}</p>
              {state.workspaceTreeLoaded && <p>{t.workspacePreviousTree}</p>}
              <button className="btn" disabled={state.workspaceLoading}
                onClick={() => void store.openWorkspace(workspace)}>{t.wsRetry}</button>
            </div>}
            {state.workspaceScopeError && <p role="alert">{t.workspaceAssetsFailed} {state.workspaceScopeError}</p>}
            {state.workspaceIssues.length > 0 && <details>
              <summary>{t.workspacePartial} ({state.workspaceIssues.length})</summary>
              <ul>{state.workspaceIssues.slice(0, 50).map((issue, index) => <li key={`${issue.path}-${index}`}>
                <span>{issue.path}</span>
                <span>{issue.code === "depth" ? t.workspaceDepthLimit : issue.code === "limit" ? t.workspaceEntryLimit
                  : issue.code === "encoding" ? t.workspacePathEncoding : issue.message}</span>
              </li>)}</ul>
              {state.workspaceIssues.length > 50 && <p>{t.workspaceMoreIssues}</p>}
            </details>}
          </div>}
          {workspace ? (
            <div className="sidebar-tree" role="tree" aria-label={t.sidebarTitle} aria-description={t.sidebarTypeAhead} aria-busy={state.workspaceLoading}
              onKeyDown={(e) => {
                if (imeComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
                if (e.shiftKey && e.key !== "F10" && e.key.length !== 1) return;
                const index = rows.findIndex((r) => r.node.path === (e.target as HTMLElement).dataset.treePath);
                if (index < 0) return;
                const row = rows[index];
                if (e.key === "ArrowDown") focusRow(rows[Math.min(index + 1, rows.length - 1)]?.node.path);
                else if (e.key === "ArrowUp") focusRow(rows[Math.max(index - 1, 0)]?.node.path);
                else if (e.key === "Home") focusRow(rows[0]?.node.path);
                else if (e.key === "End") focusRow(rows[rows.length - 1]?.node.path);
                else if (e.key === "ArrowRight") {
                  if (row.node.kind === "dir") {
                    if (!row.expanded) toggle(row.node.path);
                    else if (rows[index + 1]?.parent === row.node.path) focusRow(rows[index + 1].node.path);
                  }
                } else if (e.key === "ArrowLeft") {
                  if (row.node.kind === "dir" && row.expanded && !query.trim()) toggle(row.node.path);
                  else focusRow(row.parent ?? undefined);
                } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                  const rect = (e.target as HTMLElement).getBoundingClientRect();
                  setFileCtx({ x: rect.left + 16, y: rect.bottom, path: row.node.path, isDir: row.node.kind === "dir" });
                } else if (e.key === "Escape") {
                  typeAhead.current = { text: "", at: 0 };
                  filterRef.current?.focus();
                } else if (e.key.length === 1 && e.key !== " " && !e.repeat) {
                  const now = Date.now(), letter = e.key.normalize("NFC").toLocaleLowerCase();
                  const previous = typeAhead.current;
                  const text = now - previous.at < 700 ? previous.text + letter : letter;
                  typeAhead.current = { text, at: now };
                  const repeated = Array.from(text).every((char) => char === letter);
                  const prefix = repeated ? letter : text;
                  // Continue a word at the current row; repeated letters cycle matches.
                  for (let step = repeated ? 1 : 0; step < rows.length + (repeated ? 1 : 0); step++) {
                    const candidate = rows[(index + step) % rows.length].node;
                    if ((candidate.stem ?? candidate.name).normalize("NFC").toLocaleLowerCase().startsWith(prefix)) {
                      focusRow(candidate.path); break;
                    }
                  }
                } else return;
                if (e.key.length !== 1) typeAhead.current = { text: "", at: 0 };
                e.preventDefault();
                e.stopPropagation();
              }}>
              {renderedRows}
              {rows.length === 0 && !state.workspaceLoading && !state.workspaceError && state.workspaceTreeLoaded &&
                state.workspaceIssues.length === 0 && <div className="sidebar-empty" role="status">{query ? t.sidebarNoResults : t.sidebarEmptyFolder}</div>}
            </div>
          ) : (
            <div className="sidebar-empty">{t.emptyNoDocHint}</div>
          )}
          <RecentDocuments store={store} t={t} />
        </div>
        <div
          className="sidebar-resizer"
          role="separator" aria-orientation="vertical" aria-label={t.sidebarResize}
          aria-valuemin={160} aria-valuemax={420} aria-valuenow={width} tabIndex={open ? 0 : -1}
          onKeyDown={(e) => {
            if (imeComposing(e) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
            e.preventDefault();
            store.setSidebarWidth(e.key === "Home" ? 160 : e.key === "End" ? 420 : Math.min(420, Math.max(160, width + (e.key === "ArrowLeft" ? -10 : 10))));
          }}
          onMouseDown={(e) => {
            pendingW.current = width;
            resizing.current = { startX: e.clientX, startW: width };
            document.body.classList.add("resizing");
          }}
        />
      </div>
      {fileCtx && (
        <div
          className="ctx-menu file-ctx" ref={menuRef} role="menu"
          aria-label={t.sidebarMenu}
          onKeyDown={(e) => {
            if (imeComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
            const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault(); e.stopPropagation();
              items[(index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
            } else if (e.key === "Home" || e.key === "End") {
              e.preventDefault(); e.stopPropagation(); items[e.key === "Home" ? 0 : items.length - 1]?.focus();
            } else if (e.key === "Escape") {
              e.preventDefault(); e.stopPropagation(); closeFileMenu();
            } else if (e.key === "Tab") closeFileMenu();
          }}
          style={{ left: fileCtx.x, top: fileCtx.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {fileCtx.isDir && (
            <>
              <button className="ctx-item" role="menuitem" disabled={fileBusy || !isInApp()} onClick={() => runFileOp("new")}>
                {t.ctxNewFile}
              </button>
              {workspace && isInApp() && <button className="ctx-item" role="menuitem" disabled={fileBusy} onClick={() => startFolder(fileCtx.path)}>
                {t.ctxNewFolder}
              </button>}
            </>
          )}
          {!fileCtx.isDir && (
            <>
              <button
                className="ctx-item" role="menuitem" disabled={fileBusy || !pendingLoaded || pendingLoading || !!pendingError || pendingJobs.length > 0}
                onClick={() => {
                  if (operationBusy.current) return;
                  const p = fileCtx.path;
                  closeFileMenu();
                  setRenameError("");
                  setRenaming({ root: store.state.workspace, path: p, name: p.split("/").pop()?.replace(/\.(md|markdown)$/i, "") ?? "" });
                }}
              >
                {t.ctxRename}
              </button>
              <button className="ctx-item" role="menuitem" disabled={fileBusy || !isInApp()} onClick={() => runFileOp("dup")}>
                {t.ctxDuplicate}
              </button>
              <button className="ctx-item" role="menuitem" disabled={!isInApp() || !state.favoritesLoaded || state.favoritesBusy || state.favoritesLoading}
                onClick={() => {
                  const path = fileCtx.path, present = !store.isFavorite(path);
                  closeFileMenu(); void store.setFavorite(path, present);
                }}>{store.isFavorite(fileCtx.path) ? t.favoriteRemove : t.favoriteAdd}</button>
              <button className="ctx-item" role="menuitem" disabled={fileBusy || !isInApp() || !workspace} onClick={() => {
                if (operationBusy.current || !workspace || store.state.workspace !== workspace) return;
                const path = fileCtx.path;
                closeFileMenu();
                const context = store.beginWorkspaceFileAction();
                setTrashing({ root: workspace, path, isCurrent: context.isWorkspaceCurrent });
              }}>{t.ctxTrash}</button>
            </>
          )}
          <button className="ctx-item" role="menuitem" onClick={() => runFileOp("reveal")}>
            {t.tabReveal}
          </button>
        </div>
      )}
      {linkReview && reviewOpen && <RenameLinksReview store={store} target={linkReview} t={t} onClose={(complete) => {
        setReviewOpen(false);
        if (complete) {
          ++pendingSequence.current;
          setPendingJobs((jobs) => jobs.filter((job) => job.id !== linkReview.id));
        }
        setLinkReview(null);
        void reloadPending();
      }} />}
      {newFolder && workspace === newFolder.root && <NewFolderDialog key={`${newFolder.root}\0${newFolder.dir}`} store={store}
        root={newFolder.root} dir={newFolder.dir} t={t} onClose={() => setNewFolder(null)} onCreated={folderCreated} />}
      {trashing && workspace === trashing.root && <TrashDocumentDialog key={`${trashing.root}\0${trashing.path}`} store={store}
        {...trashing} t={t} onClose={() => setTrashing(null)} />}
      {renaming && (
        <div
          className="overlay modal-overlay"
          role="dialog"
          aria-modal="true" aria-labelledby="rename-title" aria-busy={renameBusy}
          onKeyDown={(e) => {
            if (!imeComposing(e) && e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              if (!renameBusyRef.current) setRenaming(null);
            }
          }}
          onClick={(e) => !renameBusyRef.current && e.target === e.currentTarget && setRenaming(null)}
        >
          <div className="modal rename-dialog">
            <div className="modal-title" id="rename-title">{t.ctxRename}</div>
            <input
              className="palette-input"
              autoFocus aria-label={t.renameFilename} disabled={renameBusy}
              aria-invalid={!!renameError} aria-describedby={renameError ? "rename-error" : undefined}
              onFocus={(e) => e.currentTarget.select()}
              value={renaming.name}
              onChange={(e) => { setRenameError(""); setRenaming({ ...renaming, name: e.target.value }); }}
              onKeyDown={(e) => {
                if (imeComposing(e)) return; // IME 조합 중 키는 IME가 소비(한글 Esc·Enter 새기기 방지)
                if (e.key === "Enter") {
                  e.preventDefault();
                  void doRename(renaming.name);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!renameBusyRef.current) setRenaming(null);
                }
              }}
            />
            {renameError && <p id="rename-error" role="alert" className="rename-error">{renameError}</p>}
            <div className="modal-actions">
              <button className="btn btn-primary" disabled={renameBusy || !renaming.name.trim()} onClick={() => void doRename(renaming.name)}>
                {renameBusy ? t.loading : t.renameAction}
              </button>
              <button className="btn btn-plain" disabled={renameBusy} onClick={() => setRenaming(null)}>
                {t.cancel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

