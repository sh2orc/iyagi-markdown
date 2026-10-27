// 백링크 패널 — 현재 문서를 위키·일반 Markdown 링크로 참조하는 문서들.
// 스캔은 Rust가 워크스페이스 전체에서(전체 검색과 같은 풀·규칙).
// 목록·하이라이트는 전체 검색 패널의 것을 재사용해 같은 조작감을 준다.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { imeComposing } from "../app/ime";
import { api, isInApp } from "../api";
import type { AppStore } from "../app/store";
import { splitHighlights } from "../search/searchCm";
import { groupHits, type Group } from "./WorkspaceSearch";
import type { Translate } from "../i18n";

type Row =
  | { kind: "header"; g: Group }
  | { kind: "hit"; g: Group; lineNo: number; line: string };

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onOpenHit: (path: string, lineNo: number) => void;
}

export function BacklinksPanel({ store, t, onClose, onOpenHit }: Props): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const path = store.active?.path ?? null;
  const workspace = state.workspace;
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const stem = path ? path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "") : "";
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    setSel(0); setGroups(null); setError(null);
    if (!path || !workspace || !isInApp()) {
      setGroups([]);
      return;
    }
    let disposed = false;
    const revision = state.linksRevision;
    const current = () => !disposed && store.state.workspace === workspace &&
      store.active?.path === path && store.state.linksRevision === revision;
    const timer = setTimeout(() => {
      const previous = requestRef.current;
      const request = (async () => {
        await previous;
        if (!current()) return;
        try {
          const hits = await api.backlinks(workspace, path);
          if (current()) {
            const next = groupHits(hits, workspace);
            setGroups(next);
            setSel(next.length ? 1 : 0); // First row is a file header.
          }
        } catch (reason) {
          if (current()) { setError(String(reason)); setGroups([]); }
        }
      })();
      requestRef.current = request;
      void request.then(() => { if (requestRef.current === request) requestRef.current = null; });
    }, 250);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [path, workspace, state.linksRevision, reload]);

  const rows = useMemo<Row[]>(() => {
    if (!groups) return [];
    const out: Row[] = [];
    for (const g of groups) {
      out.push({ kind: "header", g });
      for (const h of g.hits) out.push({ kind: "hit", g, lineNo: h.lineNo, line: h.line });
    }
    return out;
  }, [groups]);

  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

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
    // 오버레이 자체에 포커스를 둬 키보드 탐색이 가능하게(입력창이 없으므로).
    panelRef.current?.focus();
  }, []);

  const runIdx = (i: number) => {
    const r = rows[i];
    if (!r || r.kind !== "hit") return;
    onClose();
    onOpenHit(r.g.path, r.lineNo);
  };

  return (
    <div
      ref={panelRef}
      className="overlay palette-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="backlinks-panel-title"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (imeComposing(e)) return;
        if (e.key === "Enter" && (e.target as HTMLElement).closest("button")) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSel((v) => step(v, 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSel((v) => step(v, -1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          runIdx(sel);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette wssearch">
        <div className="palette-input palette-input-static">
          <span id="backlinks-panel-title">{t.backlinksTitle}</span>
          {stem && !error && groups !== null && <span className="wssearch-count">{groups?.length ?? 0}</span>}
        </div>
        <div className="palette-list" ref={listRef}>
          {groups === null && <div className="palette-empty">…</div>}
          {error && <div className="palette-empty" role="alert"><p>{t.wikiLoadFailed}: {error}</p>
            <button className="btn" onClick={() => setReload((n) => n + 1)}>{t.wsRetry}</button></div>}
          {!error && groups !== null && groups.length === 0 && (
            <div className="palette-empty">
              {path ? t.backlinksEmpty : t.emptyNoDoc}
            </div>
          )}
          {rows.map((r, i) => {
            if (r.kind === "header") {
              return (
                <div key={`h-${r.g.path}`} className="palette-section wssearch-file">
                  <span className="wssearch-name">{r.g.name}</span>
                  <span className="palette-file-path">{r.g.rel || r.g.path}</span>
                  <span className="wssearch-count">{r.g.hits.length}</span>
                </div>
              );
            }
            const selected = i === sel;
            return (
              <button
                key={`b-${r.g.path}-${r.lineNo}`}
                className={`palette-item wssearch-hit ${selected ? "is-sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => runIdx(i)}
              >
                <span className="wssearch-lineno">{r.lineNo}</span>
                <span className="wssearch-text">
                  {r.line
                    ? splitHighlights(r.line, stem).map((p, j) =>
                        p.hit ? (
                          <mark key={j} className="wssearch-mark">
                            {p.text}
                          </mark>
                        ) : (
                          <span key={j}>{p.text}</span>
                        ),
                      )
                    : " "}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
