// 명령 팔레트(⌘⇧P) — 모든 기능을 검색으로 즉시 실행. 단축키를 몰라도
// 기능 이름만으로 도달한다(Word 리본 검색 · VS Code 팔레트).
// 하이브리드: 워크스페이스·최근 파일도 같이 퍼지 검색해 바로 연다
// (Obsidian 퀵 스위처 · Xcode Open Quickly).

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { api, isInApp } from "../api";
import type { AppStore } from "../app/store";
import { dailyNoteTitle } from "../app/dailyNote";
import { flattenFiles, scoreFile, subsequence, type FileEntry } from "../app/quickOpen";
import type { Translate } from "../i18n";
import * as fmt from "../editor/format";
import { tidyDocument } from "../editor/tableFormat";
import { splitHighlights } from "../search/searchCm";
import { copyFormat, pasteFormat } from "../editor/formatPainter";
import { pasteAsPlainText } from "../editor/cm";
import { collectHeadings } from "../links";
import { foldAll, unfoldAll } from "@codemirror/language";
import { DOC_TEMPLATES, templateName, templateContent } from "../app/templates";
import { imeComposing } from "../app/ime";

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

function rowKey(row: Row): string | null {
  return row.kind === "cmd" ? `cmd:${row.c.id}` : row.kind === "file" ? `file:${row.f.path}` : null;
}

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onCloseDocument: () => void;
  onOpenDiff?: () => void;
  onOpenGraph?: () => void;
  onNewFromTemplate?: (content: string) => void;
  onOpenTemplates?: (initialId?: string) => void;
  onOpenWsSearch?: () => void;
  onOpenVersions?: () => void;
  onOpenBacklinks?: () => void;
  onOpenBrokenLinks?: () => void;
  onOpenShortcuts: () => void;
  onOpenStats: () => void;
  onOpenRenameHeading: () => void;
  onOpenSymbols?: () => void;
  onOpenTableDialog?: () => void;
  onOpenComments?: () => void;
  onAddComment?: () => void;
  onOpenReview?: () => void;
  onOpenTrack?: (action: "start" | "accept" | "stop") => void;
  onOpenFrontMatter?: () => void;
  onOpenStyle: () => void;
  onOpenPrint: () => void;
  onOpenExport: (kind: "html" | "pdf" | "docx") => void;
}

export function CommandPalette({
  store,
  t,
  onClose,
  onCloseDocument,
  onOpenShortcuts,
  onOpenStats, onOpenRenameHeading,
  onOpenSymbols,
  onOpenTableDialog,
  onOpenComments,
  onOpenReview,
  onOpenTrack,
  onOpenFrontMatter,
  onOpenStyle,
  onOpenPrint,
  onOpenExport,
  onOpenDiff,
  onOpenGraph,
  onNewFromTemplate,
  onOpenTemplates,
  onOpenWsSearch,
  onOpenVersions,
  onOpenBacklinks,
  onOpenBrokenLinks,
  onAddComment,
}: Props): JSX.Element {
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const listId = useId();
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const workspaceHistory = useSyncExternalStore(store.workspaceHistory.subscribe, store.workspaceHistory.getSnapshot);
  const active = store.active;
  const currentView = store.view;
  const favoritePaths = useMemo(() => new Set(state.favorites), [state.favorites]);
  const files = useMemo(() => flattenFiles([
    ...state.favorites.map((path) => ({ path, name: path.split("/").pop() ?? path })), ...state.recent,
  ], state.tree, state.workspace), [state.favorites, state.recent, state.tree, state.workspace]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commands: Cmd[] = useMemo(() => {
    const view = store.view;
    const sourceId = store.active?.id;
    const editable = !!view && !!store.active && store.active.mode !== "read";
    // 잠긴(읽기 전용) 문서의 편집 명령 차단 — 입력 차단과 일관(144차).
    // 조용히 무시하지 않고 안내(25~28차 조용한 실패 규칙).
    const go = (fn: () => void) => () => {
      if (!view || sourceId === undefined || store.view !== view || store.active?.id !== sourceId) return;
      const ro = view.state.readOnly;
      if (ro) store.toast(t.lockedNoEdit, "error");
      else fn();
      view?.focus();
    };
    const cmds: Cmd[] = [
      { id: "recover-documents", label: `${t.scFile}: ${t.recoverDocuments}`, run: () => void store.retryRecovery() },
      ...workspaceHistory.entries.map((entry) => ({
        id: `workspace:${entry.path}`, label: `${t.workspaceRecent}: ${entry.name} — ${entry.path}`,
        run: () => { void store.openWorkspace(entry.path); },
      })),
      { id: "mode-read", label: `${t.scView}: ${t.modeRead} ⌘E`, run: () => store.toggleReadEdit() },
      { id: "navigate-back", label: `${t.scView}: ${t.navigateBack} ⌥⌘←`, run: () => store.navigateHistory(false) },
      { id: "navigate-forward", label: `${t.scView}: ${t.navigateForward} ⌥⌘→`, run: () => store.navigateHistory(true) },
      { id: "mode-source", label: `${t.scView}: ${t.modeSource} ⌘/`, run: () => store.setMode(store.active?.mode === "source" ? "edit" : "source") },
      { id: "source-preview", label: `${t.scView}: ${t.toggleSourcePreview}`, run: () => store.toggleSourcePreview() },
      { id: "theme-toggle", label: `${t.scView}: ${t.cmdThemeToggle}`, run: () => store.setTheme(store.state.theme === "dark" ? "light" : "dark") },
      { id: "sidebar", label: `${t.scView}: ${t.toggleSidebar} ⇧⌘B`, run: () => store.setSidebar(!store.state.sidebarOpen) },
      { id: "toc", label: `${t.scView}: ${t.tocTitle} ⌥⌘T`, run: () => store.setToc(!store.state.tocOpen) },
      { id: "save", label: `${t.scFile}: ${t.save} ⌘S`, run: () => void store.saveActive() },
      { id: "stats", label: `${t.statsTitle}`, run: onOpenStats },
      ...(onOpenSymbols ? [{ id: "symbols", label: `${t.symbolTitle}…`, run: onOpenSymbols }] : []),
      { id: "style", label: `${t.styleTitle} — Aa`, run: onOpenStyle },
      { id: "shortcuts", label: `${t.shortcutsTitle}`, run: onOpenShortcuts },
      ...(onOpenGraph ? [{ id: "graph", label: `${t.graphTitle}`, run: onOpenGraph }] : []),
      ...(onOpenTemplates ? [{ id: "templates", label: t.templateBrowse, run: () => onOpenTemplates() }] : []),
      ...(onOpenTemplates || onNewFromTemplate
        ? DOC_TEMPLATES.map((tpl) => ({
            id: `tpl-${tpl.id}`,
            label: `${t.newFromTemplate}: ${templateName(tpl, t.lang)}`,
            run: () => onOpenTemplates ? onOpenTemplates(tpl.id) : onNewFromTemplate?.(templateContent(tpl, t.lang)),
          }))
        : []),
      ...(onOpenDiff ? [{ id: "diff", label: `${t.diffTitle}…`, run: onOpenDiff }] : []),
      ...(onOpenWsSearch ? [{ id: "wssearch", label: `${t.wsSearchTitle} ⇧⌘F`, run: onOpenWsSearch }] : []),
      ...(onOpenVersions ? [{ id: "versions", label: `${t.scFile}: ${t.versionsTitle}`, run: onOpenVersions }] : []),
      // 로그 폴더 — 문제 보고·디버깅 경로(앱 안에서만, 실패는 안내).
      ...(isInApp()
        ? [
            {
              id: "logs-open",
              label: `${t.scFile}: ${t.logsOpen}`,
              run: () => {
                void api.openLogsDir().catch(() => store.toast(t.logsOpenFailed, "error"));
              },
            },
          ]
        : []),
      ...(onOpenBacklinks ? [{ id: "backlinks", label: `${t.scView}: ${t.backlinksTitle}`, run: onOpenBacklinks }] : []),
      ...(onOpenComments ? [{ id: "comments", label: `${t.commentsTitle}…`, run: onOpenComments }] : []),
      // 커서 줄에 메모 추가 — 우클릭 메뉴와 같은 대화상자(팔레티 진입은 그동안
      // 죽은 배선이었다: prop만 선언되고 호출처가 없었다).
      ...(onAddComment ? [{ id: "comment-add", label: `${t.scReview}: ${t.ctxAddComment}`, run: () => onAddComment() }] : []),
      ...(onOpenReview ? [{ id: "review", label: `${t.reviewTitle}…`, run: onOpenReview }] : []),
      ...(onOpenFrontMatter ? [{ id: "frontmatter", label: `${t.fmTitle}…`, run: onOpenFrontMatter }] : []),
      ...(onOpenBrokenLinks ? [{ id: "broken-links", label: `${t.scEdit}: ${t.brokenLinksTitle}`, run: onOpenBrokenLinks }] : []),
      { id: "speak", label: `${t.scView}: ${t.speakStart}`, run: () => store.speakActive() },
      { id: "speak-stop", label: `${t.scView}: ${t.speakStop}`, run: () => store.speakStop() },
      { id: "print", label: `${t.printPreviewTitle} ⌘P`, run: onOpenPrint },
      { id: "export-html", label: `${t.exportTitle} — ${t.exportHtml}`, run: () => onOpenExport("html") },
      { id: "export-pdf", label: `${t.exportTitle} — ${t.exportPdf}`, run: () => onOpenExport("pdf") },
      { id: "export-docx", label: `${t.exportTitle} — ${t.exportDocx}`, run: () => onOpenExport("docx") },
      { id: "bookmark", label: `${t.ctxAddBookmark} / ${t.ctxRemoveBookmark}`, run: () => { void store.toggleBookmark(); } },
      { id: "bm-next", label: `${t.bookmarksSection}: ${t.bmNext}`, run: () => store.cycleBookmark(true) },
      ...(view ? [
        { id: "fold-all", label: `${t.scView}: ${t.foldAll}`, run: go(() => foldAll(view)) },
        { id: "unfold-all", label: `${t.scView}: ${t.unfoldAll}`, run: go(() => unfoldAll(view)) },
      ] : []),
      { id: "bm-prev", label: `${t.bookmarksSection}: ${t.bmPrev}`, run: () => store.cycleBookmark(false) },
      { id: "align-doc-l", label: `${t.scFormat}: ${t.ctxAlign} — ${t.alignLeft}`, run: () => store.setAlign("left") },
      { id: "align-doc-c", label: `${t.scFormat}: ${t.ctxAlign} — ${t.alignCenter}`, run: () => store.setAlign("center") },
      { id: "align-doc-r", label: `${t.scFormat}: ${t.ctxAlign} — ${t.alignRight}`, run: () => store.setAlign("right") },
      { id: "align-doc-j", label: `${t.scFormat}: ${t.ctxAlign} — ${t.alignJustify}`, run: () => store.setAlign("justify") },
      ...(onOpenTrack ? [
        { id: "track-start", label: `${t.scReview}: ${t.trackStart}…`, run: () => onOpenTrack("start") },
        { id: "track-accept", label: `${t.scReview}: ${t.trackAccept}…`, run: () => onOpenTrack("accept") },
        { id: "track-stop", label: `${t.scReview}: ${t.trackStop}…`, run: () => onOpenTrack("stop") },
      ] : []),
      { id: "track-next", label: `${t.scReview}: ${t.trackNext}`, run: () => store.nextChange(true) },
      { id: "track-prev", label: `${t.scReview}: ${t.trackPrev}`, run: () => store.nextChange(false) },
      { id: "tw-toggle", label: `${t.scView}: ${t.setTypewriter}`, run: () => store.toggleTypewriter() },
      { id: "focus-toggle", label: `${t.scView}: ${t.setFocusMode}`, run: () => store.toggleFocusMode() },
      { id: "fm-marks", label: `${t.scView}: ${t.setFormattingMarks}`, run: () => store.toggleFormattingMarks() },
      { id: "sentence-toggle", label: `${t.scView}: ${t.setFocusSentence}`, run: () => store.toggleSentenceFocus() },
      { id: "newtab", label: `${t.newTab} ⌘N`, run: () => store.newTab() },
      { id: "daily-note", label: `${t.scFile}: ${t.cmdDailyNote} (${dailyNoteTitle()})`, run: () => void store.openDailyNote() },
      { id: "rename-heading", label: `${t.scEdit}: ${t.cmdRenameHeading}`, run: () => void onOpenRenameHeading() },
      { id: "closetab", label: `${t.closeTab} ⌘W`, run: onCloseDocument },
      ...(store.canReopenClosedTab ? [{ id: "reopen-closed-tab", label: `${t.reopenClosedTab} ⇧⌘T`,
        run: () => void store.reopenClosedTab() }] : []),
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
        { id: "sort-lines", label: `${t.scEdit}: ${t.cmdSortLines}`, run: go(() => fmt.sortLines(view)) },
        { id: "sort-lines-desc", label: `${t.scEdit}: ${t.cmdSortLinesDesc}`, run: go(() => fmt.sortLines(view, { reverse: true })) },
        { id: "dedupe-lines", label: `${t.scEdit}: ${t.cmdDedupeLines}`, run: go(() => fmt.sortLines(view, { unique: true })) },
        { id: "h1", label: `${t.scFormat}: ${t.tbHeading} 1`, run: go(() => fmt.toggleHeading(view, 1)) },
        { id: "h2", label: `${t.scFormat}: ${t.tbHeading} 2`, run: go(() => fmt.toggleHeading(view, 2)) },
        { id: "h3", label: `${t.scFormat}: ${t.tbHeading} 3`, run: go(() => fmt.toggleHeading(view, 3)) },
        { id: "h4", label: `${t.scFormat}: ${t.tbHeading} 4`, run: go(() => fmt.toggleHeading(view, 4)) },
        { id: "h5", label: `${t.scFormat}: ${t.tbHeading} 5`, run: go(() => fmt.toggleHeading(view, 5)) },
        { id: "h6", label: `${t.scFormat}: ${t.tbHeading} 6`, run: go(() => fmt.toggleHeading(view, 6)) },
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
  }, [store, t, currentView, active?.id, active?.mode, active?.path, workspaceHistory.entries, store.canReopenClosedTab, onCloseDocument,
    onOpenStats, onOpenStyle, onOpenShortcuts, onOpenPrint, onOpenExport, onOpenTrack,
    onOpenSymbols, onOpenGraph, onNewFromTemplate, onOpenTemplates, onOpenDiff, onOpenWsSearch,
    onOpenVersions, onOpenBacklinks, onOpenComments, onAddComment, onOpenReview,
    onOpenFrontMatter, onOpenBrokenLinks, onOpenTableDialog]);

  const rows = useMemo<Row[]>(() => {
    const raw = query.trimStart();
    // @심볼 모드 — 현재 문서의 제목 퍼지 점프(VS Code @ 내비게이션).
    if (raw.startsWith("@")) {
      const q = raw.slice(1).trim();
      const source = store.active;
      const sourceDoc = source?.state.doc;
      const doc = sourceDoc?.toString() ?? "";
      const heads = collectHeadings(doc);
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
          label: `L${sourceDoc?.lineAt(Math.min(r.h.pos, sourceDoc.length)).number ?? 0} ${"  ".repeat(Math.max(0, r.h.level - 1))}${"#".repeat(r.h.level)} ${r.h.text}`,
          hint: q,
          run: () => {
            const view = store.view;
            if (!view || store.active !== source || view.state.doc !== sourceDoc) return;
            store.revealLocation({ pos: r.h.pos });
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
      const favorites = files.filter((file) => favoritePaths.has(file.path));
      const otherFiles = files.filter((file) => !favoritePaths.has(file.path));
      if (favorites.length > 0) {
        out.push({ kind: "header", label: t.favoritesTitle });
        for (const f of favorites.slice(0, 8)) out.push({ kind: "file", f });
      }
      if (otherFiles.length > 0) {
        out.push({ kind: "header", label: t.paletteRecentFiles });
        for (const f of otherFiles.slice(0, 8)) out.push({ kind: "file", f });
      }
      return out;
    }
    const cmdHits = commands
      .map((c) => ({ c, s: subsequence(q, c.label) }))
      .filter((r) => r.s > 0)
      // 동점(예: 'review'가 "Review…"와 "Review: Add comment"에서 같은 접두
      // 점수)은 짧은 라벨 우선 — 정확히 그 이름인 항목이 더 긴 형제에게
      // 목록 순서만으로 밀려 바로 가기가 엉뚱해지는 일을 막는다.
      .sort((a, b) => b.s - a.s || a.c.label.length - b.c.label.length);
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
  }, [commands, files, favoritePaths, query, t, state.activeId, store.active?.state.doc]);

  // Track the selected action, not its position: async file updates can insert
  // rows above it. A new query or a removed action selects the first usable row.
  const selectedIndex = selectedKey === null ? -1 : rows.findIndex((row) => rowKey(row) === selectedKey);
  const sel = selectedIndex >= 0 ? selectedIndex : rows.findIndex((row) => row.kind !== "header");
  const select = (index: number) => setSelectedKey(rows[index] ? rowKey(rows[index]) : null);

  // 구분선을 건너뛰고 목록 끝에서는 마지막 실행 가능한 선택을 유지한다.
  const step = (from: number, delta: number): number => {
    for (let next = from + delta; next >= 0 && next < rows.length; next += delta) {
      if (rows[next].kind !== "header") return next;
    }
    return from;
  };

  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel, rows]);

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

  // 콤보박스 a11y — 포커스는 입력창에 둔 채 가상 선택을 스크린 리더가 읽게.
  const activeId =
    sel >= 0 ? `${listId}-opt-${sel}` : undefined;

  return (
    <div className="overlay palette-overlay" role="dialog" aria-modal="true" aria-label={t.palettePlaceholder}
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette">
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-label={t.palettePlaceholder}
          aria-autocomplete="list"
          aria-expanded={true}
          aria-controls={listId}
          aria-activedescendant={activeId}
          placeholder={t.palettePlaceholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedKey(null); }}
          onKeyDown={(e) => {
            if (imeComposing(e)) return; // IME 조합 중 키는 IME가 소비(한글 Esc·Enter 새기기 방지)
            if (e.key === "ArrowDown") {
              e.preventDefault();
              select(step(sel, 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              select(step(sel, -1));
            } else if (e.key === "PageDown" || e.key === "PageUp") {
              e.preventDefault();
              let next = sel;
              for (let i = 0; i < 10; i++) next = step(next, e.key === "PageDown" ? 1 : -1);
              select(next);
            } else if (e.key === "Tab") {
              // This combobox has one keyboard focus stop; options use arrows.
              e.preventDefault();
            } else if (e.key === "Enter") {
              e.preventDefault();
              runIdx(sel);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        {!query.trimStart().startsWith("@") && state.workspace &&
          (state.workspaceLoading || state.workspaceError || state.workspaceIssues.length > 0) &&
          <div className="workspace-status" role="status"><p>
            {state.workspaceLoading ? t.workspaceLoading : state.workspaceError ? t.workspaceFailed : t.workspacePartial}
          </p></div>}
        <div className="palette-list" ref={listRef} role="listbox" id={listId} aria-label={t.palettePlaceholder}>
          {rows.length === 0 && (
            <div className="palette-empty" role="status">
              {query.trimStart().startsWith("@") ? t.paletteNoHeadings : t.paletteNoMatch}
            </div>
          )}
          {rows.map((r, i) => {
            if (r.kind === "header") {
              return (
                <div key={`h-${r.label}`} className="palette-section" role="presentation">
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
                <button
                  key={r.c.id}
                  id={`${listId}-opt-${i}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === sel}
                  className={cls}
                  onMouseEnter={() => select(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => runIdx(i)}
                >
                  <span className="palette-cmd-text">{body}</span>
                  {kbd && <kbd className="palette-kbd">{kbd}</kbd>}
                </button>
              );
            }
            const openTab = store.state.tabs.some((t) => t.path === r.f.path);
            return (
              <button
                key={`f-${r.f.path}`}
                id={`${listId}-opt-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === sel}
                className={`${cls} palette-file`}
                onMouseEnter={() => select(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runIdx(i)}
              >
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
