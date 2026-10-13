// 버전 기록 패널 — 저장이 교체한 이전 상태들(스냅숏 사이드카)을 보여 주고
// 되돌린다(Obsidian file recovery·Notion 버전 기록). 되돌리기는 버퍼만 바꾼다
// — 사용자가 저장(⌘S)해야 확정된다(실수로 원문까지 즉시 덮지 않게).

import { useEffect, useMemo, useRef, useState } from "react";

import { api, isInApp, type SnapshotInfo } from "../api";
import type { AppStore } from "../app/store";
import { diffLines, diffSummary } from "../editor/diff";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onRestore: (text: string) => void;
}

function relTime(t: Translate, ts: number): string {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return t.timeJustNow;
  if (min < 60) return t.f.minAgo(min);
  const hr = Math.round(min / 60);
  if (hr < 24) return t.f.hourAgo(hr);
  const day = Math.round(hr / 24);
  if (day < 7) return t.f.dayAgo(day);
  return new Date(ts).toLocaleString();
}

export function VersionsPanel({ store, t, onClose, onRestore }: Props): JSX.Element | null {
  const path = store.active?.path ?? null;
  const [list, setList] = useState<SnapshotInfo[] | null>(null);
  const [sel, setSel] = useState(-1);
  const [preview, setPreview] = useState<string | null>(null);
  const [view, setView] = useState<"preview" | "diff">("diff");
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 오버레이 자체 포커스 — 키보드 탐색(다른 패널과 같은 규칙).
    listRef.current?.parentElement?.focus();
  }, []);

  const step = (from: number, delta: number): number => {
    let i = from;
    const n = items?.length ?? 0;
    for (;;) {
      const next = i + delta;
      if (next < 0 || next >= n) return i;
      i = next;
    }
  };

  useEffect(() => {
    setSel(-1);
    setPreview(null);
    if (!path || !isInApp()) {
      setList([]);
      return;
    }
    let disposed = false;
    void api
      .snapshotList(path)
      .then((l) => {
        if (!disposed) setList(l);
      })
      .catch(() => {
        if (!disposed) setList([]);
      });
    return () => {
      disposed = true;
    };
  }, [path]);

  useEffect(() => {
    if (!path || sel < 0 || !list || !list[sel]) {
      setPreview(null);
      return;
    }
    let disposed = false;
    const ts = list[sel].ts;
    setPreview(null); // 로드 중 표시
    void api
      .snapshotRead(path, ts)
      .then((text) => {
        if (!disposed) setPreview(text);
      })
      .catch(() => {
        if (!disposed) setPreview(null);
      });
    return () => {
      disposed = true;
    };
  }, [path, sel, list]);

  // 목록은 새 것부터(가장 최근의 이전 상태가 위).
  const items = list ? [...list].reverse() : null;

  // 변경사항: 현재 버퍼 → 이 버전. add=복원으로 얻는 줄, del=잃는 줄.
  const currentText = store.active?.state.doc.toString() ?? null;
  const ops = useMemo(
    () => (view === "diff" && preview !== null && currentText !== null ? diffLines(currentText, preview) : []),
    [view, preview, currentText],
  );
  const summary = useMemo(() => diffSummary(ops), [ops]);

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
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
          const snap = items?.[sel];
          if (snap && preview !== null) onRestore(preview);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal versions-modal">
        <div className="modal-title">
          {t.versionsTitle}
          <span className="modal-file-name">{store.active?.title ?? t.untitled}</span>
        </div>
        <div className="versions-body">
          <div className="versions-list" ref={listRef}>
            {items === null && <div className="palette-empty">…</div>}
            {items !== null && items.length === 0 && (
              <div className="palette-empty">{path ? t.versionsEmpty : t.emptyNoDoc}</div>
            )}
            {items?.map((s, i) => (
              <button
                key={s.ts}
                className={`versions-item ${i === sel ? "is-sel" : ""}`}
                onClick={() => setSel(i)}
              >
                <span className="versions-time">{relTime(t, s.ts)}</span>
                <span className="versions-size">{s.size.toLocaleString()} B</span>
              </button>
            ))}
          </div>
          <div className="versions-preview">
            <div className="versions-viewbar">
              <button
                className={`versions-viewbtn ${view === "diff" ? "is-on" : ""}`}
                onClick={() => setView("diff")}
              >
                {t.versionsViewDiff}
                {preview !== null && ops.length > 0 && (
                  <span className="diff-summary">
                    {" "}
                    <span className="diff-add-c">+{summary.added}</span>{" "}
                    <span className="diff-del-c">−{summary.removed}</span>
                  </span>
                )}
              </button>
              <button
                className={`versions-viewbtn ${view === "preview" ? "is-on" : ""}`}
                onClick={() => setView("preview")}
              >
                {t.versionsViewPreview}
              </button>
            </div>
            {preview === null ? (
              <div className="palette-empty">{sel < 0 ? t.versionsPick : "…"}</div>
            ) : view === "diff" ? (
              ops.length === 0 ? (
                <div className="palette-empty">{t.diffSame}</div>
              ) : (
                <div className="versions-diff">
                  {ops.map((op, i) => (
                    <pre key={i} className={`diff-line diff-${op.kind}`}>
                      <span className="diff-gutter">{op.kind === "add" ? "+" : op.kind === "del" ? "−" : " "}</span>
                      <code>{op.text}</code>
                    </pre>
                  ))}
                </div>
              )
            ) : (
              <pre>{preview}</pre>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {t.close}
          </button>
          <button
            className="btn btn-primary"
            disabled={preview === null}
            onClick={() => {
              if (preview !== null) onRestore(preview);
            }}
          >
            {t.versionsRestore}
          </button>
        </div>
      </div>
    </div>
  );
}
