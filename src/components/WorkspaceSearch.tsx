// 워크스페이스 전체 검색(⌘⇧F) — 폴더 안 모든 마크다운에서 줄 단위 검색.
// 결과는 파일별로 묶고, 클릭하면 해당 문서의 해당 줄로 연다
// (VS Code 사이드바 검색 · Obsidian 검색). 스캔은 Rust가 스레드 풀에서.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { api, isInApp, type SearchHit, type SearchReport, type ReplacementPreview, type ReplacementReport } from "../api";
import type { AppStore } from "../app/store";
import { splitHighlights } from "../search/searchCm";
import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";

export interface Group {
  path: string;
  name: string;
  rel: string;
  hits: SearchHit[];
}

type Row =
  | { kind: "header"; g: Group }
  | { kind: "hit"; g: Group; h: SearchHit };

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onOpenHit: (path: string, lineNo: number) => void;
  /** 초기 검색어(태그 클릭 등 — 패널이 열리며 채워진다). */
  initialQuery?: string;
}

/** 같은 파일의 매치를 하나의 묶음으로 — Rust 결과는 도달 순이라 이미 연속. */
export function groupHits(hits: SearchHit[], root: string): Group[] {
  const out: Group[] = [];
  for (const h of hits) {
    const last = out[out.length - 1];
    if (last && last.path === h.path) {
      last.hits.push(h);
      continue;
    }
    const dir = h.path.slice(0, h.path.lastIndexOf("/"));
    const rel = dir === root ? "" : root && dir.startsWith(root + "/") ? dir.slice(root.length + 1) : dir;
    out.push({ path: h.path, name: h.path.slice(h.path.lastIndexOf("/") + 1), rel, hits: [h] });
  }
  return out;
}

export function WorkspaceSearch({ store, t, onClose, onOpenHit, initialQuery }: Props): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const root = state.workspace;
  const [query, setQuery] = useState(initialQuery ?? "");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [results, setResults] = useState<{ q: string; root: string; caseSensitive: boolean; contentRevision: number;
    groups: Group[]; report: SearchReport } | null>(null);
  const [preview, setPreview] = useState<{ data: ReplacementPreview; root: string; q: string; replacement: string; caseSensitive: boolean } | null>(null);
  const [report, setReport] = useState<ReplacementReport | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const reqId = useRef(0);
  const alive = useRef(true);
  const searchRequest = useRef<Promise<void> | null>(null);
  const q = query.trim();

  useEffect(() => {
    alive.current = true;
    inputRef.current?.focus();
    return () => { alive.current = false; reqId.current += 1; };
  }, []);
  useEffect(() => {
    if (!busy && !preview && !report) inputRef.current?.focus();
  }, [busy, preview, report]);

  useEffect(() => {
    const id = ++reqId.current;
    setResults(null);
    setSel(-1);
    setSearchError(null);
    if (!q || !root || !isInApp()) { setLoading(false); return; }
    const contentRevision = state.linksRevision;
    const current = () => alive.current && reqId.current === id &&
      store.state.workspace === root && store.state.linksRevision === contentRevision;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const previous = searchRequest.current;
      const request = (async () => {
        await previous;
        if (!current()) return;
        try {
          const report = await api.searchWorkspace(root, q, caseSensitive);
          if (!current()) return;
          setResults({ q, root, caseSensitive, contentRevision, groups: groupHits(report.hits, root), report });
          setSel(report.hits.length ? 1 : -1);
        } catch (e) {
          if (current()) setSearchError(`${t.wsSearchFailed} ${String(e)}`);
        } finally { if (current()) setLoading(false); }
      })();
      searchRequest.current = request;
      void request.then(() => { if (searchRequest.current === request) searchRequest.current = null; });
    }, 200);
    return () => { window.clearTimeout(timer); reqId.current += 1; };
  }, [q, root, caseSensitive, revision, state.linksRevision, t.wsSearchFailed]);

  const currentResults = results?.q === q && results.root === root && results.caseSensitive === caseSensitive &&
    results.contentRevision === state.linksRevision ? results : null;
  const rows = useMemo<Row[]>(() => currentResults?.groups.flatMap((g) => [
    { kind: "header" as const, g }, ...g.hits.map((h) => ({ kind: "hit" as const, g, h })),
  ]) ?? [], [currentResults]);
  useEffect(() => { (listRef.current?.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const step = (delta: number) => setSel((from) => {
    for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
      if (rows[i].kind === "hit") return i;
    }
    return from;
  });
  const openRow = (index: number) => {
    const row = rows[index];
    if (busyRef.current || !row || row.kind !== "hit") return;
    onClose();
    onOpenHit(row.g.path, row.h.lineNo);
  };
  const previewChanged = !!preview && (preview.root !== root || preview.q !== q ||
    preview.replacement !== replacement || preview.caseSensitive !== caseSensitive);
  const dirtyPaths = new Set(state.tabs.filter((tab) => tab.dirty || tab.conflict || store.lockedTabIds.has(tab.id)).map((tab) => tab.path));
  const dirtyBlocked = preview?.data.files.some((file) => dirtyPaths.has(file.path)) ?? false;
  const changeCount = preview?.data.files.reduce((n, file) => n + file.count, 0) ?? 0;
  const refresh = () => { setPreview(null); setReport(null); setError(null); setSearchError(null); setRevision((n) => n + 1); inputRef.current?.focus(); };

  const prepare = async () => {
    if (busyRef.current || !root || !q || !isInApp()) return;
    busyRef.current = true; setBusy(true); setError(null); setReport(null);
    try {
      const data = await api.previewReplacement(root, q, replacement, caseSensitive);
      if (alive.current) setPreview({ data, root, q, replacement, caseSensitive });
    } catch (e) { if (alive.current) setError(String(e)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const apply = async () => {
    if (busyRef.current || !preview || previewChanged || dirtyBlocked || !preview.data.files.length) return;
    // Recheck live buffers at the click boundary, not only at the previous render.
    store.syncActiveState();
    if (store.state.workspace !== preview.root || store.state.tabs.some((tab) =>
      (tab.dirty || tab.conflict || store.lockedTabIds.has(tab.id)) && preview.data.files.some((file) => file.path === tab.path))) {
      setError(t.wsDirtyBlocked); return;
    }
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const outcome = await api.applyReplacement(preview.data.id);
      for (const file of outcome.applied) store.externalChange(file.path, "changed");
      if (alive.current) { setReport(outcome); setPreview(null); }
    } catch (e) { if (alive.current) { setError(e === "REPLACEMENT_PREVIEW_EXPIRED" ? t.wsPreviewExpired : String(e)); setPreview(null); } }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };

  return (
    <div className="overlay palette-overlay" role="dialog" aria-modal="true" aria-labelledby="wssearch-title"
      onClick={(e) => { if (e.target === e.currentTarget && !busyRef.current) onClose(); }}
      onKeyDown={(e) => {
        if (imeComposing(e)) return;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (!busyRef.current) onClose(); }
      }}>
      <div className="palette wssearch" aria-busy={busy || loading}>
        <div className="wssearch-heading"><strong id="wssearch-title">{t.wsSearchTitle}</strong>
          <button className="btn btn-plain" disabled={busy} onClick={onClose}>{t.close}</button></div>
        <input ref={inputRef} className="palette-input" role="combobox" aria-label={t.wsSearchPlaceholder}
          aria-expanded={!preview && !report && rows.length > 0} aria-controls={!preview && !report ? "wssearch-listbox" : undefined}
          aria-activedescendant={!preview && !report && rows[sel]?.kind === "hit" ? `wssearch-opt-${sel}` : undefined}
          placeholder={!root ? t.wsSearchNoFolder : t.wsSearchPlaceholder} value={query}
          disabled={!root || busy || !!preview || !!report} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (imeComposing(e)) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); step(e.key === "ArrowDown" ? 1 : -1); }
            else if (e.key === "Enter") { e.preventDefault(); openRow(sel); }
          }} />
        <div className="wssearch-controls">
          <button className="search-toggle" aria-pressed={replaceOpen} disabled={busy || !!preview || !!report}
            onClick={() => setReplaceOpen(!replaceOpen)}>{t.replacePlaceholder}</button>
          <button className={`search-toggle ${caseSensitive ? "is-on" : ""}`} aria-label={t.findCaseSensitive}
            title={t.findCaseSensitive} aria-pressed={caseSensitive} disabled={busy || !!preview || !!report}
            onClick={() => setCaseSensitive(!caseSensitive)}>Aa</button>
        </div>
        {replaceOpen && <div className="searchbar-row wssearch-replace">
          <input className="search-input" aria-label={t.replacePlaceholder} placeholder={t.replacePlaceholder}
            value={replacement} disabled={busy || !!preview || !!report} onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => { if (!imeComposing(e) && e.key === "Enter") { e.preventDefault(); void prepare(); } }} />
          <button className="btn" disabled={!root || !q || busy || !!preview || !!report || !isInApp()} onClick={() => void prepare()}>{t.wsPreview}</button>
        </div>}
        {busy && <p className="wssearch-status" role="status">{t.loading}</p>}
        {error && <div className="wssearch-status" role="alert">{error}
          <button className="btn" disabled={busy} onClick={refresh}>{t.wsRetry}</button></div>}
        {!preview && !report && searchError && <div className="wssearch-status" role="alert">{searchError}
          <button className="btn" disabled={busy} onClick={refresh}>{t.wsRetry}</button></div>}
        {!preview && !report && !loading && currentResults && <div className="wssearch-status" role="status">
          {t.f.wsFilesRead(currentResults.report.filesRead, currentResults.report.filesTotal)}
          {currentResults.report.issues.length > 0 && <div role="alert">
            <p>{t.wsSearchIncomplete}</p>
            <details><summary>{t.wsSearchIssues}</summary>
              {currentResults.report.issues.slice(0, 50).map((issue, i) =>
                <p key={`${issue.path}-${i}`}>{issue.path}: {issue.message}</p>)}
              {currentResults.report.issues.length > 50 && <p>{t.workspaceMoreIssues}</p>}
            </details>
            <button className="btn" disabled={busy} onClick={refresh}>{t.wsRetry}</button>
          </div>}
        </div>}
        {preview ? <div className="wssearch-review">
          <p>{t.wsPreviewHint}</p>
          <p>{t.f.wsPreviewCount(preview.data.files.length, changeCount)}</p>
          {(dirtyBlocked || previewChanged) && <p role="alert">{dirtyBlocked ? t.wsDirtyBlocked : t.wsPreviewExpired}</p>}
          {!preview.data.files.length && <p>{t.wsNoChanges}</p>}
          <div className="wssearch-review-list">
            {preview.data.files.map((file) => <div className="wssearch-change" key={file.path}>
              <strong>{file.path.startsWith(preview.root + "/") ? file.path.slice(preview.root.length + 1) : file.path} · {file.count}</strong>
              <pre className="wssearch-before">− {file.before}</pre><pre className="wssearch-after">+ {file.after}</pre>
            </div>)}
            {preview.data.skipped.length > 0 && <><strong>{t.wsSkipped}</strong>{preview.data.skipped.map((file, index) =>
              <p key={`${file.path}-${index}`}>{file.path}: {file.message}</p>)}</>}
          </div>
          <div className="modal-actions">
            <button className="btn" disabled={busy} onClick={refresh}>{t.wsPreviewBack}</button>
            <button className="btn btn-primary" disabled={busy || dirtyBlocked || previewChanged || !preview.data.files.length}
              onClick={() => void apply()}>{t.wsApply} ({changeCount.toLocaleString()})</button>
          </div>
        </div> : report ? <div className="wssearch-review" role="status">
          <p>{t.f.wsReplaceDone(report.applied.length, report.applied.reduce((n, file) => n + file.count, 0))}</p>
          {report.applied.length > 0 && <details><summary>{t.wsAppliedFiles}</summary>
            <div className="wssearch-review-list">{report.applied.map((file) =>
              <p key={file.path}>{file.path} · {file.count}</p>)}</div>
          </details>}
          {report.failed.length > 0 && <><p>{t.wsPartial}</p><div className="wssearch-review-list">
            {report.failed.map((file, index) => <p key={`${file.path}-${index}`}>{file.path}: {file.message}</p>)}
          </div></>}
          <button className="btn" onClick={refresh}>{t.wsPreviewBack}</button>
        </div> : <div className="palette-list" ref={listRef} role="listbox" id="wssearch-listbox" aria-label={t.wsSearchTitle}>
          {loading && <div className="palette-empty" role="status">{t.wsSearching}</div>}
          {!loading && !error && !searchError && !currentResults && <div className="palette-empty">{root ? t.wsSearchHint : t.wsSearchNoFolder}</div>}
          {!loading && !error && !searchError && currentResults?.groups.length === 0 && <div className="palette-empty">
            {currentResults.report.issues.length ? t.wsSearchNoMatchPartial : t.wsSearchNoMatch}</div>}
          {rows.map((row, index) => row.kind === "header"
            ? <div key={`h-${row.g.path}`} className="palette-section wssearch-file" role="presentation">
                <span className="wssearch-name">{row.g.name}</span><span className="palette-file-path">{row.g.rel}</span>
                <span className="wssearch-count">{row.g.hits.length}</span>
              </div>
            : <button key={`m-${row.g.path}-${row.h.lineNo}`} id={`wssearch-opt-${index}`} role="option"
                tabIndex={-1} aria-selected={index === sel} className={`palette-item wssearch-hit ${index === sel ? "is-sel" : ""}`}
                onMouseEnter={() => setSel(index)} onClick={() => openRow(index)}>
                <span className="wssearch-lineno">{row.h.lineNo}</span><span className="wssearch-text">
                  {splitHighlights(row.h.line, currentResults?.q ?? "", caseSensitive).map((part, i) => part.hit
                    ? <mark key={i} className="wssearch-mark">{part.text}</mark> : <span key={i}>{part.text}</span>)}
                </span>
              </button>)}
          {currentResults?.report.truncated && <div className="palette-empty">{t.f.wsTruncated(2000)}</div>}
        </div>}
      </div>
    </div>
  );
}
