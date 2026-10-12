// 백링크 패널 — 현재 문서를 [[이름]]으로 참조하는 문서들(Obsidian 백링크).
// 스캔은 Rust가 워크스페이스 전체에서(전체 검색과 같은 풀·규칙).
// 목록·하이라이트는 전체 검색 패널의 것을 재사용해 같은 조작감을 준다.

import { useEffect, useMemo, useRef, useState } from "react";

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
  const path = store.active?.path ?? null;
  const stem = path ? path.slice(path.lastIndexOf("/") + 1).replace(/\.(md|markdown)$/i, "") : "";
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSel(0);
    if (!path || !store.state.workspace || !isInApp()) {
      setGroups([]);
      return;
    }
    let disposed = false;
    void api
      .backlinks(store.state.workspace, path)
      .then((hits) => {
        if (!disposed) setGroups(groupHits(hits, store.state.workspace ?? ""));
      })
      .catch(() => {
        if (!disposed) setGroups([]);
      });
    return () => {
      disposed = true;
    };
    // 마운트(문서 지정) 시 1회 스캔.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

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
    listRef.current?.parentElement?.focus();
  }, []);

  const runIdx = (i: number) => {
    const r = rows[i];
    if (!r || r.kind !== "hit") return;
    onClose();
    onOpenHit(r.g.path, r.lineNo);
  };

  return (
    <div
      className="overlay palette-overlay"
      tabIndex={-1}
      onKeyDown={(e) => {
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
          {t.backlinksTitle}
          {stem && <span className="wssearch-count">{groups?.length ?? 0}</span>}
        </div>
        <div className="palette-list" ref={listRef}>
          {groups === null && <div className="palette-empty">…</div>}
          {groups !== null && groups.length === 0 && (
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
