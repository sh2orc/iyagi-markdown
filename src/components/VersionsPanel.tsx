// 버전 기록 패널 — 저장이 교체한 이전 상태들(스냅숏 사이드카)을 보여 주고
// 되돌린다(Obsidian file recovery·Notion 버전 기록). 되돌리기는 버퍼만 바꾼다
// — 사용자가 저장(⌘S)해야 확정된다(실수로 원문까지 즉시 덮지 않게).

import { useEffect, useState } from "react";

import { api, isInApp, type SnapshotInfo } from "../api";
import type { AppStore } from "../app/store";
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

  return (
    <div className="overlay modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal versions-modal">
        <div className="modal-title">
          {t.versionsTitle}
          <span className="modal-file-name">{store.active?.title ?? t.untitled}</span>
        </div>
        <div className="versions-body">
          <div className="versions-list">
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
            {preview === null ? (
              <div className="palette-empty">{sel < 0 ? t.versionsPick : "…"}</div>
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
