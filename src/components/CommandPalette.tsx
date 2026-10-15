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
import { tidyDocument } from "../editor/tableFormat";
import { splitHighlights } from "../search/searchCm";
import { copyFormat, pasteFormat } from "../editor/formatPainter";
import { pasteAsPlainText } from "../editor/cm";
import { collectHeadings } from "../links";
import { stripFrontMatter } from "../editor/frontmatter";
import { smoothScrollIntoView } from "../editor/cm";
import { foldAll, unfoldAll } from "@codemirror/language";
import { DOC_TEMPLATES } from "../app/templates";

/** 라벨 끝의 단축키 토큰 분리 — "저장 ⌘S" → ["저장", "⌘S"]. 순수 함수. */
export function splitKbd(label: string): [string, string | null] {
  const m = /\s+([\u2318\u21e7\u2325\u2303\u2191\u2193][\w\u2318\u21e7\u2325\u2303\u2191\u2193+\-\/]*)$/.exec(label);
  if (!m) return [label, null];
  return [label.slice(0, m.index), m[1] ?? null];
}

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

// — 최근 명령(VS Code 방식 — 빈 쿼리에서 최근 순, 세션 간 유지) —

const RECENT_KEY = "iyagi.recentCommands";
const RECENT_MAX = 8;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(id: string): void {
  const next = [id, ...loadRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* 프라이빗 모드 등 — 세션만 */
  }
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
  onOpenGraph?: () => void;
  onNewFromTemplate?: (content: string) => void;
  onOpenWsSearch?: () => void;
  onOpenVersions?: () => void;
  onOpenBacklinks?: () => void;
  onOpenBrokenLinks?: () => void;
  onOpenShortcuts: () => void;
  onOpenStats: () => void;
  onOpenSymbols?: () => void;
  onOpenTableDialog?: () => void;
  onOpenComments?: () => void;
  onAddComment?: () => void;
  onOpenReview?: () => void;
  onOpenFrontMatter?: () => void;
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
  onOpenSymbols,
  onOpenTableDialog,
  onOpenComments,
  onOpenReview,
  onOpenFrontMatter,
  onOpenStyle,
  onOpenPrint,
  onOpenExport,
  onOpenDiff,
  onOpenGraph,
  onNewFromTemplate,
  onOpenWsSearch,
  onOpenVersions,
  onOpenBacklinks,
  onOpenBrokenLinks,
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
    // 잠긴(읽기 전용) 문서의 편집 명령은 무시 — 입력 차단과 일관(144차).
    const go = (fn: () => void) => () => {
      const ro = view ? view.state.readOnly : false;
      if (!ro) fn();
      view?.focus();
    };
    const cmds: Cmd[] = [
      { id: "mode-read", label: `${t.scView}: ${t.modeRead} ⌘E`, run: () => store.toggleReadEdit() },
      { id: "mode-source", label: `${t.scView}: ${t.modeSource} ⌘/`, run: () => store.setMode(store.active?.mode === "source" ? "edit" : "source") },
      { id: "sidebar", label: `${t.scView}: ${t.toggleSidebar} ⇧⌘B`, run: () => store.setSidebar(!store.state.sidebarOpen) },
      { id: "toc", label: `${t.scView}: ${t.tocTitle} ⇧⌘T`, run: () => store.setToc(!store.state.tocOpen) },
      { id: "save", label: `${t.scFile}: ${t.save} ⌘S`, run: () => void store.saveActive() },
      { id: "stats", label: `${t.statsTitle}`, run: onOpenStats },
      ...(onOpenSymbols ? [{ id: "symbols", label: `${t.symbolTitle}…`, run: onOpenSymbols }] : []),
      { id: "style", label: `${t.styleTitle} — Aa`, run: onOpenStyle },
      { id: "shortcuts", label: `${t.shortcutsTitle}`, run: onOpenShortcuts },
          ...(onOpenGraph ? [{ id: "graph", label: `${t.graphTitle}`, run: onOpenGraph }] : []),
          ...(onNewFromTemplate
            ? DOC_TEMPLATES.map((tpl) => ({
                id: `tpl-${tpl.id}`,
                label: `${t.newFromTemplate}: ${tpl.nameEn}`,
                run: () => onNewFromTemplate(tpl.content),
              }))
            : []),
      ...(onOpenDiff ? [{ id: "diff", label: `${t.diffTitle}…`, run: onOpenDiff }] : []),
      { id: "wssearch", label: `${t.wsSearchTitle} ⇧⌘F`, run: () => onOpenWsSearch?.() },
      { id: "versions", label: `${t.scFile}: ${t.versionsTitle}`, run: () => onOpenVersions?.() },
      { id: "backlinks", label: `${t.scView}: ${t.backlinksTitle}`, run: () => onOpenBacklinks?.() },
      ...(onOpenComments ? [{ id: "comments", label: `${t.commentsTitle}…`, run: onOpenComments }] : []),
      ...(onOpenReview ? [{ id: "review", label: `${t.reviewTitle}…`, run: onOpenReview }] : []),
      ...(onOpenFrontMatter ? [{ id: "frontmatter", label: `${t.fmTitle}…`, run: onOpenFrontMatter }] : []),
      { id: "broken-links", label: `${t.scEdit}: ${t.brokenLinksTitle}`, run: () => onOpenBrokenLinks?.() },
      { id: "speak", label: `${t.scView}: ${t.speakStart}`, run: () => store.speakActive() },
      { id: "speak-stop", label: `${t.scView}: ${t.speakStop}`, run: () => store.speakStop() },
      { id: "print", label: `${t.printPreviewTitle} ⌘P`, run: onOpenPrint },
      { id: "export-html", label: `${t.exportTitle} — ${t.exportHtml}`, run: () => onOpenExport("html") },
      { id: "export-pdf", label: `${t.exportTitle} — ${t.exportPdf}`, run: () => onOpenExport("pdf") },
      { id: "export-docx", label: `${t.exportTitle} — ${t.exportDocx}`, run: () => onOpenExport("docx") },
      { id: "bookmark", label: `${t.ctxAddBookmark} / ${t.ctxRemoveBookmark}`, run: () => store.toggleBookmark() },
      { id: "bm-next", label: `${t.bookmarksSection}: ${t.bmNext}`, run: () => store.cycleBookmark(true) },
      { id: "fold-all", label: `${t.scView}: ${t.foldAll}`, run: go(() => foldAll(store.view!)) },
      { id: "unfold-all", label: `${t.scView}: ${t.unfoldAll}`, run: go(() => unfoldAll(store.view!)) },
      { id: "bm-prev", label: `${t.bookmarksSection}: ${t.bmPrev}`, run: () => store.cycleBookmark(false) },
      { id: "align-doc-l", label: `${t.scFormat}: ${t.ctxAlign} — ${t.alignLeft}`, run: () => store.setAlign("left") },
      { id: "align-doc-c", label: `${t.scFormat}: ${t.ctxAlign} — ${t.alignCenter}`, run: () => store.setAlign("center") },
      { id: "align-doc-r", label: `${t.scFormat}: ${t.ctxAlign} — ${t.alignRight}`, run: () => store.setAlign("right") },
      { id: "align-doc-j", label: `${t.scFormat}: ${t.ctxAlign} — ${t.alignJustify}`, run: () => store.setAlign("justify") },
      { id: "track-start", label: `${t.scReview}: ${t.trackStart}`, run: () => void store.startTracking() },
      { id: "track-accept", label: `${t.scReview}: ${t.trackAccept}`, run: () => void store.acceptAllChanges() },
      { id: "track-stop", label: `${t.scReview}: ${t.trackStop}`, run: () => void store.stopTracking() },
      { id: "track-next", label: `${t.scReview}: ${t.trackNext}`, run: () => store.nextChange(true) },
      { id: "track-prev", label: `${t.scReview}: ${t.trackPrev}`, run: () => store.nextChange(false) },
      { id: "tw-toggle", label: `${t.scView}: ${t.setTypewriter}`, run: () => store.toggleTypewriter() },
      { id: "focus-toggle", label: `${t.scView}: ${t.setFocusMode}`, run: () => store.toggleFocusMode() },
      { id: "fm-marks", label: `${t.scView}: ${t.setFormattingMarks}`, run: () => store.toggleFormattingMarks() },
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
        { id: "painter-copy", label: `${t.scFormat}: ${t.painterCopy} ⌥⌘C`, run: go(() => copyFormat(view)) },
        { id: "painter-paste", label: `${t.scFormat}: ${t.painterPaste} ⌥⌘V`, run: go(() => pasteFormat(view)) },
        { id: "paste-plain", label: `${t.scEdit}: ${t.pastePlain} ⌥⌘⇧V`, run: go(() => pasteAsPlainText(view)) },
        { id: "link", label: `${t.scFormat}: ${t.tbLink}`, run: go(() => fmt.insertLink(view)) },
        { id: "math-inline", label: `${t.scFormat}: ${t.tbMath} $…$`, run: go(() => fmt.insertMath(view, false)) },
        { id: "math-block", label: `${t.scFormat}: ${t.tbMathBlock} $$…$$`, run: go(() => fmt.insertMath(view, true)) },
        { id: "case-cycle", label: `${t.scEdit}: ${t.cmdCycleCase} ⇧F3`, run: go(() => fmt.cycleCase(view)) },
        { id: "join-lines", label: `${t.scEdit}: ${t.cmdJoinLines} ⌘J`, run: go(() => fmt.joinCurrentLine(view)) },
        { id: "h1", label: `${t.scFormat}: ${t.tbHeading} 1`, run: go(() => fmt.toggleHeading(view, 1)) },
        { id: "h2", label: `${t.scFormat}: ${t.tbHeading} 2`, run: go(() => fmt.toggleHeading(view, 2)) },
        { id: "h3", label: `${t.scFormat}: ${t.tbHeading} 3`, run: go(() => fmt.toggleHeading(view, 3)) },
        { id: "ul", label: `${t.tbBullet}`, run: go(() => fmt.toggleBulletList(view)) },
        { id: "ol", label: `${t.tbNumbered}`, run: go(() => fmt.toggleOrderedList(view)) },
        { id: "quote", label: `${t.tbQuote}`, run: go(() => fmt.toggleQuote(view)) },
        { id: "wrap-code", label: `${t.scFormat}: ${t.cmdWrapCode}`, run: go(() => fmt.wrapCodeBlock(view)) },
        { id: "footnote-insert", label: `${t.scFormat}: ${t.cmdFootnote}`, run: go(() => fmt.insertFootnote(view)) },
        { id: "table", label: `${t.tbTable}`, run: go(() => fmt.insertTable(view)) },
        ...(onOpenTableDialog ? [{ id: "table-dialog", label: `${t.tbTable}: ${t.tableInsertTitle}…`, run: onOpenTableDialog }] : []),
        { id: "toc-insert", label: `${t.tbInsertToc}`, run: go(() => fmt.insertToc(view)) },
        { id: "pagebreak-insert", label: `${t.tbPageBreak}`, run: go(() => fmt.insertPageBreak(view)) },
        { id: "bookmark-next", label: `${t.bookmarksSection}: ${t.bmNext}`, run: () => store.cycleBookmark(true) },
        { id: "bookmark-prev", label: `${t.bookmarksSection}: ${t.bmPrev}`, run: () => store.cycleBookmark(false) },
        { id: "hr", label: `${t.tbRule}`, run: go(() => fmt.insertBlock(view, "---")) },
        { id: "tidy-document", label: `${t.scEdit}: ${t.cmdTidy}`, run: go(() => {
          const v = view!;
          const next = tidyDocument(v.state.doc.toString());
          if (next !== v.state.doc.toString()) {
            v.dispatch({
              changes: { from: 0, to: v.state.doc.length, insert: next },
              userEvent: "input.tidyDocument",
            });
          }
        }) },
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
        cmds.push({ id: "newwin", label: `${t.tbNewWindow} ⤢`, run: () => void api.openInNewWindow(win) });
      }
    }
    return cmds;
  }, [store, t, onOpenStats, onOpenStyle, onOpenShortcuts, onOpenPrint, onOpenExport]);

  const rows = useMemo<Row[]>(() => {
    const raw = query;
    // @심볼 모드 — 현재 문서의 제목 퍼지 점프(VS Code @ 내비게이션).
    if (raw.startsWith("@")) {
      const q = raw.slice(1).trim();
      const doc = store.active?.state.doc.toString() ?? "";
      const heads = collectHeadings(stripFrontMatter(doc));
      const hits = heads
        .map((h) => ({ h, s: q ? subsequence(q, h.text) : 1 }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40);
      return hits.map((r) => ({
        kind: "cmd" as const,
        c: {
          id: `head-${r.h.pos}`,
          // 줄 번호 접두 — 동명 제목 구분(wssearch-lineno 관례). 검색어 하이라이트
          // 렌더는 아래 rows 매핑에서 kind "cmd" 대신 특별 분기로.
          label: `L${store.active?.state.doc.lineAt(Math.min(r.h.pos, store.active.state.doc.length)).number ?? 0} ${"  ".repeat(Math.max(0, r.h.level - 1))}${"#".repeat(r.h.level)} ${r.h.text}`,
          hint: q,
          run: () => {
            const view = store.view;
            if (!view) return;
            const pos = Math.min(r.h.pos, view.state.doc.length);
            view.dispatch({ selection: { anchor: pos } });
            smoothScrollIntoView(view, pos);
            view.focus();
          },
        },
      }));
    }
    const q = query.trim();
    const out: Row[] = [];
    if (!q) {
      // 최근에 쓴 명령 우선(VS Code 방식) — 나머지는 기존 순서 유지.
      const recent = loadRecent();
      const byId = new Map(commands.map((c) => [c.id, c] as const));
      const seen = new Set<string>();
      for (const id of recent) {
        const c = byId.get(id);
        if (c) {
          out.push({ kind: "cmd", c });
          seen.add(id);
        }
      }
      for (const c of commands) {
        if (!seen.has(c.id)) out.push({ kind: "cmd", c });
      }
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
    if (r.kind === "cmd") {
      // 제목 점프(@모드)는 기록 대상이 아니다 — 목록 오염 방지.
      if (!r.c.id.startsWith("head-")) rememberRecent(r.c.id);
      r.c.run();
    } else {
      void store.openPath(r.f.path);
    }
  };

  return (
    <div className="overlay palette-overlay" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
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
          {rows.length === 0 && (
            <div className="palette-empty">
              {query.trimStart().startsWith("@") ? t.paletteNoHeadings : t.paletteNoMatch}
            </div>
          )}
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
              const [text, kbd] = splitKbd(r.c.label);
              // @모드(제목) 행은 검색어 하이라이트 — 다른 목록과 같은 조작감.
              const symQ = query.trimStart().startsWith("@") ? query.trim().slice(1) : "";
              const body =
                symQ && r.c.id.startsWith("head-")
                  ? splitHighlights(text, symQ).map((part, j) =>
                      part.hit ? (
                        <mark key={j} className="wssearch-mark">
                          {part.text}
                        </mark>
                      ) : (
                        <span key={j}>{part.text}</span>
                      ),
                    )
                  : text;
              return (
                <button key={r.c.id} className={cls} onMouseEnter={() => setSel(i)} onClick={() => runIdx(i)}>
                  <span className="palette-cmd-text">{body}</span>
                  {kbd && <kbd className="palette-kbd">{kbd}</kbd>}
                </button>
              );
            }
            const openTab = store.state.tabs.some((t) => t.path === r.f.path);
            return (
              <button key={`f-${r.f.path}`} className={`${cls} palette-file`} onMouseEnter={() => setSel(i)} onClick={() => runIdx(i)}>
                <span className="palette-file-name">{r.f.name}</span>
                {openTab && <span className="palette-open-dot" title={t.alreadyOpen}>●</span>}
                {r.f.rel && <span className="palette-file-path">{r.f.rel}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
