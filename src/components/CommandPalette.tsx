// 명령 팔레트(⌘⇧P) — 모든 기능을 검색으로 즉시 실행. 단축키를 몰라도
// 기능 이름만으로 도달한다(Word 리본 검색 · VS Code 팔레트).

import { useEffect, useMemo, useRef, useState } from "react";

import { isInApp } from "../api";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import * as fmt from "../editor/format";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onOpenShortcuts: () => void;
  onOpenStats: () => void;
  onOpenStyle: () => void;
  onOpenPrint: () => void;
  onOpenExport: (kind: "html" | "pdf" | "docx") => void;
}

/** 서브시퀀스 퍼지 매칭 — "표정렬" 같은 입력에도 "표: 정렬(가운데)"가 걸린다. */
function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  let qi = 0;
  let score = 0;
  const hay = text.toLowerCase();
  for (const ch of query.toLowerCase()) {
    const idx = hay.indexOf(ch, qi);
    if (idx === -1) return -1;
    score += idx === qi ? 2 : 1; // 연속 매치 가중치
    qi = idx + 1;
  }
  return score;
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
}: Props): JSX.Element {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
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
      { id: "print", label: `${t.printPreviewTitle} ⌘P`, run: onOpenPrint },
      { id: "export-html", label: `${t.exportTitle} — ${t.exportHtml}`, run: () => onOpenExport("html") },
      { id: "export-pdf", label: `${t.exportTitle} — ${t.exportPdf}`, run: () => onOpenExport("pdf") },
      { id: "export-docx", label: `${t.exportTitle} — ${t.exportDocx}`, run: () => onOpenExport("docx") },
      { id: "bookmark", label: `${t.ctxAddBookmark} / ${t.ctxRemoveBookmark}`, run: () => store.toggleBookmark() },
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
      );
      const win = store.active?.path;
      if (win && isInApp()) {
        cmds.push({ id: "newwin", label: `${t.tbNewWindow} ⤢`, run: () => void import("../api").then((a) => a.api.openInNewWindow(win)) });
      }
    }
    return cmds;
  }, [store, t, onOpenStats, onOpenStyle, onOpenShortcuts, onOpenPrint, onOpenExport]);

  const results = useMemo(() => {
    if (!query.trim()) return commands.map((c) => ({ c, s: 1 }));
    return commands
      .map((c) => ({ c, s: fuzzyScore(query.trim(), c.label) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s);
  }, [commands, query]);

  useEffect(() => {
    setSel(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const runIdx = (i: number) => {
    const r = results[i];
    if (!r) return;
    onClose();
    r.c.run();
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
              setSel((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
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
          {results.length === 0 && <div className="palette-empty">{t.paletteNoMatch}</div>}
          {results.map((r, i) => (
            <button
              key={r.c.id}
              className={`palette-item ${i === sel ? "is-sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => runIdx(i)}
            >
              {r.c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
