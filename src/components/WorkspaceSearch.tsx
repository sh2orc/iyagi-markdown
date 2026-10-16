// 워크스페이스 전체 검색(⌘⇧F) — 폴더 안 모든 마크다운에서 줄 단위 검색.
// 결과는 파일별로 묶고, 클릭하면 해당 문서의 해당 줄로 연다
// (VS Code 사이드바 검색 · Obsidian 검색). 스캔은 Rust가 스레드 풀에서.

import { useEffect, useMemo, useRef, useState } from "react";

import { api, isInApp, type SearchHit } from "../api";
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
    const rel = root && dir.startsWith(root + "/") ? dir.slice(root.length + 1) : dir;
    out.push({ path: h.path, name: h.path.slice(h.path.lastIndexOf("/") + 1), rel, hits: [h] });
  }
  return out;
}

export function WorkspaceSearch({ store, t, onClose, onOpenHit, initialQuery }: Props): JSX.Element {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [sel, setSel] = useState(0);
  const [truncated, setTruncated] = useState(false);
  /** 결과를 만든 쿼리 — 하이라이트가 타이핑 도중 어긋나지 않게 함께 저장. */
  const [results, setResults] = useState<{ q: string; groups: Group[] } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 입력 디바운스(200ms) — 키 입력마다 전체 폴더을 긁지 않게.
  useEffect(() => {
    const q = query.trim();
    if (!q || !isInApp() || !store.state.workspace) {
      setResults(q ? { q, groups: [] } : null);
      setTruncated(false);
      return;
    }
    const root = store.state.workspace;
    const id = ++reqId.current;
    const timer = window.setTimeout(() => {
      void api
        .searchWorkspace(root, q)
        .then((hits) => {
          if (reqId.current !== id) return; // 이미 다음 쿼리가 출발했다
          setTruncated(hits.length >= 2000);
          setResults({ q, groups: groupHits(hits, root) });
        })
        .catch(() => {
          if (reqId.current === id) setResults({ q, groups: [] });
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, store]);

  const rows = useMemo<Row[]>(() => {
    if (!results) return [];
    const out: Row[] = [];
    for (const g of results.groups) {
      out.push({ kind: "header", g });
      for (const h of g.hits) out.push({ kind: "hit", g, h });
    }
    return out;
  }, [results]);

  useEffect(() => {
    setSel(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  // 헤더 행은 건너뛰는 이동(팔레트와 같은 규칙).
  const step = (from: number, delta: number): number => {
    let i = from;
    for (;;) {
      const next = i + delta;
      if (next < 0 || next >= rows.length) return i;
      if (rows[next].kind !== "header") return next;
      i = next;
    }
  };

  const runIdx = (i: number) => {
    const r = rows[i];
    if (!r || r.kind !== "hit") return;
    onClose();
    onOpenHit(r.g.path, r.h.lineNo);
  };

  const noWorkspace = !store.state.workspace;
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);

  const totalMatches = results?.groups.reduce((n, g) => n + g.hits.length, 0) ?? 0;

  const replaceAll = async () => {
    const root = store.state.workspace;
    if (!root || !query.trim()) return;
    const ok = window.confirm(t.f.wsReplaceConfirm(totalMatches));
    if (!ok) return;
    try {
      const outcomes = await api.replaceWorkspace(root, query.trim(), replacement, caseSensitive);
      const files = outcomes.length;
      const count = outcomes.reduce((n, o) => n + o.count, 0);
      store.toast(t.f.wsReplaceDone(files, count));
      setResults(null); // 재검색 유도
      setQuery("");
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  return (
    <div className="overlay palette-overlay" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette wssearch">
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-expanded={rows.some((r) => r.kind !== "header")}
          aria-controls="wssearch-listbox"
          aria-activedescendant={rows[sel] && rows[sel].kind !== "header" ? `wssearch-opt-${sel}` : undefined}
          placeholder={noWorkspace ? t.wsSearchNoFolder : t.wsSearchPlaceholder}
          value={query}
          disabled={noWorkspace}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (imeComposing(e)) return; // IME 조합 중 키는 IME가 소비(한글 Esc·Enter 새기기 방지)
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
        <button
          className="search-toggle wssearch-replace-toggle"
          aria-label={t.replacePlaceholder}
          title={t.replacePlaceholder}
          onClick={() => setReplaceOpen(!replaceOpen)}
        >
          ⇄
        </button>
        {replaceOpen && (
          <div className="searchbar-row wssearch-replace">
            <input
              className="search-input"
              placeholder={t.replacePlaceholder}
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                if (imeComposing(e)) return; // IME 조합 중 키는 IME가 소비(한글 Esc·Enter 새기기 방지)
                if (e.key === "Enter") {
                  e.preventDefault();
                  void replaceAll();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setReplaceOpen(false);
                }
              }}
            />
            <button
              className={`search-toggle ${caseSensitive ? "is-on" : ""}`}
              aria-label={t.findCaseSensitive}
              title={t.findCaseSensitive}
              onClick={() => setCaseSensitive(!caseSensitive)}
            >
              Aa
            </button>
            <button
              className="search-toggle"
              disabled={!query.trim() || totalMatches === 0}
              title={`${t.findReplaceAll} (${totalMatches})`}
              onClick={() => void replaceAll()}
            >
              {t.findReplaceAll}{totalMatches > 0 ? ` (${totalMatches})` : ""}
            </button>
          </div>
        )}
        <div
          className="palette-list"
          ref={listRef}
          role="listbox"
          id="wssearch-listbox"
          aria-label={noWorkspace ? t.wsSearchNoFolder : t.wsSearchPlaceholder}
        >
          {results === null && <div className="palette-empty">{t.wsSearchHint}</div>}
          {results !== null && results.groups.length === 0 && query.trim() && (
            <div className="palette-empty">{t.wsSearchNoMatch}</div>
          )}
          {rows.map((r, i) => {
            if (r.kind === "header") {
              return (
                <div key={`h-${r.g.path}`} className="palette-section wssearch-file" role="presentation">
                  <span className="wssearch-name">{r.g.name}</span>
                  <span className="palette-file-path">{r.g.rel || r.g.path}</span>
                  <span className="wssearch-count">{r.g.hits.length}</span>
                </div>
              );
            }
            const selected = i === sel;
            return (
              <button
                key={`m-${r.g.path}-${r.h.lineNo}`}
                id={`wssearch-opt-${i}`}
                role="option"
                aria-selected={selected}
                className={`palette-item wssearch-hit ${selected ? "is-sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => runIdx(i)}
              >
                <span className="wssearch-lineno">{r.h.lineNo}</span>
                <span className="wssearch-text">
                  {r.h.line
                    ? splitHighlights(r.h.line, results?.q ?? "").map((p, j) =>
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
          {truncated && <div className="palette-empty wssearch-more">{t.f.wsTruncated(2000)}</div>}
        </div>
      </div>
    </div>
  );
}
