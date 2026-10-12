// 워크스페이스 전체 검색(⌘⇧F) — 폴더 안 모든 마크다운에서 줄 단위 검색.
// 결과는 파일별로 묶고, 클릭하면 해당 문서의 해당 줄로 연다
// (VS Code 사이드바 검색 · Obsidian 검색). 스캔은 Rust가 스레드 풀에서.

import { useEffect, useMemo, useRef, useState } from "react";

import { api, isInApp, type SearchHit } from "../api";
import type { AppStore } from "../app/store";
import { splitHighlights } from "../search/searchCm";
import type { Translate } from "../i18n";

interface Group {
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
}

/** 같은 파일의 매치를 하나의 묶음으로 — Rust 결과는 도달 순이라 이미 연속. */
function groupHits(hits: SearchHit[], root: string): Group[] {
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

export function WorkspaceSearch({ store, t, onClose, onOpenHit }: Props): JSX.Element {
  const [query, setQuery] = useState("");
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

  return (
    <div className="overlay palette-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette wssearch">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={noWorkspace ? t.wsSearchNoFolder : t.wsSearchPlaceholder}
          value={query}
          disabled={noWorkspace}
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
          {results === null && <div className="palette-empty">{t.wsSearchHint}</div>}
          {results !== null && results.groups.length === 0 && query.trim() && (
            <div className="palette-empty">{t.wsSearchNoMatch}</div>
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
                key={`m-${r.g.path}-${r.h.lineNo}`}
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
