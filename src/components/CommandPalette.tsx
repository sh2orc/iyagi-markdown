// 명령 팔레트(⌘⇧P) — 모든 기능을 검색으로 즉시 실행. 단축키를 몰라도
// 기능 이름만으로 도달한다(Word 리본 검색 · VS Code 팔레트).
// 하이브리드: 워크스페이스·최근 파일도 같이 퍼지 검색해 바로 연다
// (Obsidian 퀵 스위처 · Xcode Open Quickly).

import { useEffect, useMemo, useRef, useState } from "react";

import { api, isInApp, type TreeNode } from "../api";
import type { AppStore } from "../app/store";
import { flattenFiles, scoreFile, subsequence, type FileEntry } from "../app/quickOpen";
import type { Translate } from "../i18n";
import * as fmt from "../editor/format";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

type Row =
  | { kind: "header"; label: string }
  | { kind: "cmd"; c: Cmd }
  | { kind: "file"; f: FileEntry };

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onOpenDiff?: () => void;
  onOpenWsSearch?: () => void;
  onOpenVersions?: () => void;
  onOpenBacklinks?: () => void;
  onOpenShortcuts: () => void;
  onOpenStats: () => void;
  onOpenStyle: () => void;
  onOpenPrint: () => void;
  onOpenExport: (kind: "html" | "pdf" | "docx") => void;
}

export function CommandPalette({
  store,
  t,
  onClose,
  onOpenShortcuts,
  onOpenStats,
  onOpenStyle,
  onOpenPrint,
  onOpenExport,
  onOpenDiff,
  onOpenWsSearch,
  onOpenVersions,
  onOpenBacklinks,
}: Props): JSX.Element {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<FileEntry[] | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 파일 후보는 마운트 시 1회 수집 — 최근 문서 → 워크스페이스 트리 순서.
  useEffect(() => {
    if (!isInApp()) {
      setFiles([]);
      return;
    }
    let disposed = false;
    void (async () => {
      let recent: { path: string; name: string }[] = [];
      let tree: TreeNode[] | null = null;
      try {
        recent = await api.getRecent();
      } catch {
        /* 무시 — 폴백 */
      }
      const root = store.state.workspace;
      if (root) {
        try {
          tree = await api.scanWorkspace(root);
        } catch {
          /* 무시 */
        }
      }
      if (!disposed) setFiles(flattenFiles(recent, tree, root));
    })();
    return () => {
      disposed = true;
    };
    // 마운트 시 1회 의도 — store.workspace를 다시 읽지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commands: Cmd[] = useMemo(() => {
    const view = store.view;
    const editable = !!view && store.active?.mode !== "read";
    const go = (fn: () => void) => () => {
      fn();
      view?.focus();
    };
    const cmds: Cmd[] = [
      { id: "mode-read", label: `${t.scView}: ${t.modeRead} ⌘E`, run: () => store.toggleReadEdit() },
      { id: "mode-source", label: `${t.scView}: ${t.modeSource} ⌘/`, run: () => store.setMode(store.active?.mode === "source" ? "edit" : "source") },
      { id: "sidebar", label: `${t.scView}: ${t.toggleSidebar} ⇧⌘B`, run: () => store.setSidebar(!store.state.sidebarOpen) },
      { id: "toc", label: `${t.scView}: ${t.tocTitle} ⇧⌘T`, run: () => store.setToc(!store.state.tocOpen) },
      { id: "save", label: `${t.scFile}: ${t.save} ⌘S`, run: () => void store.saveActive() },
      { id: "stats", label: `${t.statsTitle}`, run: onOpenStats },
      { id: "style", label: `${t.styleTitle} — Aa`, run: onOpenStyle },
      { id: "shortcuts", label: `${t.shortcutsTitle}`, run: onOpenShortcuts },
      ...(onOpenDiff ? [{ id: "diff", label: `${t.diffTitle}…`, run: onOpenDiff }] : []),
      { id: "wssearch", label: `${t.wsSearchTitle} ⇧⌘F`, run: () => onOpenWsSearch?.() },
      { id: "versions", label: `${t.scFile}: ${t.versionsTitle}`, run: () => onOpenVersions?.() },
      { id: "backlinks", label: `${t.scView}: ${t.backlinksTitle}`, run: () => onOpenBacklinks?.() },
      { id: "print", label: `${t.printPreviewTitle} ⌘P`, run: onOpenPrint },
      { id: "export-html", label: `${t.exportTitle} — ${t.exportHtml}`, run: () => onOpenExport("html") },
      { id: "export-pdf", label: `${t.exportTitle} — ${t.exportPdf}`, run: () => onOpenExport("pdf") },
      { id: "export-docx", label: `${t.exportTitle} — ${t.exportDocx}`, run: () => onOpenExport("docx") },
      { id: "bookmark", label: `${t.ctxAddBookmark} / ${t.ctxRemoveBookmark}`, run: () => store.toggleBookmark() },
      { id: "tw-toggle", label: `${t.scView}: ${t.setTypewriter}`, run: () => store.toggleTypewriter() },
      { id: "focus-toggle", label: `${t.scView}: ${t.setFocusMode}`, run: () => store.toggleFocusMode() },
      { id: "sentence-toggle", label: `${t.scView}: ${t.setFocusSentence}`, run: () => store.toggleSentenceFocus() },
      { id: "newtab", label: `${t.newTab} ⌘N`, run: () => store.newTab() },
      { id: "closetab", label: `${t.closeTab} ⌘W`, run: () => {
        const tab = store.active;
        if (tab) store.closeTab(tab.id);
      } },
    ];
    if (editable && view) {
      cmds.push(
        { id: "bold", label: `${t.scFormat}: ${t.tbBold} ⌘B`, run: go(() => fmt.toggleBold(view)) },
        { id: "italic", label: `${t.scFormat}: ${t.tbItalic} ⌘I`, run: go(() => fmt.toggleItalic(view)) },
        { id: "strike", label: `${t.scFormat}: ${t.tbStrike} ⇧⌘X`, run: go(() => fmt.toggleStrikethrough(view)) },
        { id: "code", label: `${t.scFormat}: ${t.tbCode} ⇧⌘K`, run: go(() => fmt.toggleInlineCode(view)) },
        { id: "highlight", label: `${t.scFormat}: ${t.tbHighlight} ⇧⌘H`, run: go(() => fmt.toggleHighlight(view)) },
        { id: "link", label: `${t.scFormat}: ${t.tbLink}`, run: go(() => fmt.insertLink(view)) },
        { id: "h1", label: `${t.scFormat}: ${t.tbHeading} 1`, run: go(() => fmt.toggleHeading(view, 1)) },
        { id: "h2", label: `${t.scFormat}: ${t.tbHeading} 2`, run: go(() => fmt.toggleHeading(view, 2)) },
        { id: "h3", label: `${t.scFormat}: ${t.tbHeading} 3`, run: go(() => fmt.toggleHeading(view, 3)) },
        { id: "ul", label: `${t.tbBullet}`, run: go(() => fmt.toggleBulletList(view)) },
        { id: "ol", label: `${t.tbNumbered}`, run: go(() => fmt.toggleOrderedList(view)) },
        { id: "quote", label: `${t.tbQuote}`, run: go(() => fmt.toggleQuote(view)) },
        { id: "table", label: `${t.tbTable}`, run: go(() => fmt.insertTable(view)) },
        { id: "hr", label: `${t.tbRule}`, run: go(() => fmt.insertBlock(view, "---")) },
        { id: "row-add", label: `${t.ctxAddRow}`, run: go(() => fmt.tableAddRow(view)) },
        { id: "row-del", label: `${t.ctxDelRow}`, run: go(() => fmt.tableDeleteRow(view)) },
        { id: "col-add", label: `${t.ctxAddCol}`, run: go(() => fmt.tableAddColumn(view)) },
        { id: "col-del", label: `${t.ctxDelCol}`, run: go(() => fmt.tableDeleteColumn(view)) },
        { id: "align-l", label: `${t.ctxAlign}: ${t.alignLeft}`, run: go(() => fmt.tableAlignColumn(view, "left")) },
        { id: "align-c", label: `${t.ctxAlign}: ${t.alignCenter}`, run: go(() => fmt.tableAlignColumn(view, "center")) },
        { id: "align-r", label: `${t.ctxAlign}: ${t.alignRight}`, run: go(() => fmt.tableAlignColumn(view, "right")) },
        { id: "table-format", label: `${t.scTable}: ${t.ctxFormatTable}`, run: go(() => fmt.formatTable(view)) },
      );
      const win = store.active?.path;
      if (win && isInApp()) {
        cmds.push({ id: "newwin", label: `${t.tbNewWindow} ⤢`, run: () => void import("../api").then((a) => a.api.openInNewWindow(win)) });
      }
    }
    return cmds;
  }, [store, t, onOpenStats, onOpenStyle, onOpenShortcuts, onOpenPrint, onOpenExport]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const out: Row[] = [];
    if (!q) {
      for (const c of commands) out.push({ kind: "cmd", c });
      if (files && files.length > 0) {
        out.push({ kind: "header", label: t.paletteRecentFiles });
        for (const f of files.slice(0, 8)) out.push({ kind: "file", f });
      }
      return out;
    }
    const cmdHits = commands
      .map((c) => ({ c, s: subsequence(q, c.label) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s);
    for (const r of cmdHits) out.push({ kind: "cmd", c: r.c });
    if (files) {
      const fileHits = files
        .map((f) => ({ f, s: scoreFile(q, f) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40);
      if (fileHits.length > 0) {
        out.push({ kind: "header", label: t.paletteFiles });
        for (const r of fileHits) out.push({ kind: "file", f: r.f });
      }
    }
    return out;
  }, [commands, files, query, t]);

  // 헤더 행은 건너뛰는 이동.
  const step = (from: number, delta: number): number => {
    let i = from;
    for (;;) {
      const next = i + delta;
      if (next < 0 || next >= rows.length) return i;
      if (rows[next].kind !== "header") return next;
      i = next;
    }
  };

  useEffect(() => {
    setSel(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const runIdx = (i: number) => {
    const r = rows[i];
    if (!r || r.kind === "header") return;
    onClose();
    if (r.kind === "cmd") r.c.run();
    else void store.openPath(r.f.path);
  };

  return (
    <div className="overlay palette-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={t.palettePlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => step(s, 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => step(s, -1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runIdx(sel);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && <div className="palette-empty">{t.paletteNoMatch}</div>}
          {rows.map((r, i) => {
            if (r.kind === "header") {
              return (
                <div key={`h-${r.label}`} className="palette-section">
                  {r.label}
                </div>
              );
            }
            const cls = `palette-item ${i === sel ? "is-sel" : ""}`;
            if (r.kind === "cmd") {
              return (
                <button key={r.c.id} className={cls} onMouseEnter={() => setSel(i)} onClick={() => runIdx(i)}>
                  {r.c.label}
                </button>
              );
            }
            return (
              <button key={`f-${r.f.path}`} className={`${cls} palette-file`} onMouseEnter={() => setSel(i)} onClick={() => runIdx(i)}>
                <span className="palette-file-name">{r.f.name}</span>
                {r.f.rel && <span className="palette-file-path">{r.f.rel}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
