// 목록·미리보기·복원이 선택한 시각을 공유하며 복원 전 버퍼를 반드시 보존한다.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { api, isInApp, type SnapshotInfo } from "../api";
import type { AppStore } from "../app/store";
import { imeComposing } from "../app/ime";
import { diffLines, diffSummary } from "../editor/diff";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onRestored: () => void;
}

const PREVIEW_LIMIT = 200_000;

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

export function VersionsPanel({ store, t, onClose, onRestored }: Props): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // 패널을 연 뒤 탭이 바뀌어도 기록의 대상을 바꾸지 않는다.
  const [target] = useState(() => {
    const tab = store.active;
    return { id: tab?.id, path: tab?.path ?? null, title: tab?.title ?? t.untitled };
  });
  const tab = state.tabs.find((item) => item.id === target.id);
  const targetValid = !!tab && tab.path === target.path && state.activeId === target.id;
  const locked = !!target.id && store.lockedTabIds.has(target.id);
  const [items, setItems] = useState<SnapshotInfo[] | null>(null);
  const [selectedTs, setSelectedTs] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ ts: number; text: string } | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [readError, setReadError] = useState<{ ts: number; message: string } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [listAttempt, setListAttempt] = useState(0);
  const [readAttempt, setReadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [view, setView] = useState<"preview" | "diff">("diff");
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    overlayRef.current?.focus();
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    setItems(null);
    setListError(null);
    setSelectedTs(null);
    setPreview(null);
    if (!target.path || !isInApp()) {
      setItems([]);
      return;
    }
    let disposed = false;
    void api.snapshotList(target.path).then((list) => {
      if (disposed) return;
      const sorted = [...list].sort((a, b) => b.ts - a.ts);
      setItems(sorted);
      setSelectedTs(sorted[0]?.ts ?? null);
    }).catch((error: unknown) => {
      if (!disposed) setListError(String(error));
    });
    return () => { disposed = true; };
  }, [target.path, listAttempt]);

  useEffect(() => {
    setPreview(null);
    setReadError(null);
    if (!target.path || selectedTs === null) return;
    let disposed = false;
    const ts = selectedTs;
    void api.snapshotRead(target.path, ts).then((text) => {
      if (!disposed) setPreview({ ts, text });
    }).catch((error: unknown) => {
      if (!disposed) setReadError({ ts, message: String(error) });
    });
    return () => { disposed = true; };
  }, [target.path, selectedTs, readAttempt]);

  // 새 선택의 렌더부터 effect 실행 전까지도 이전 내용을 복원할 수 없게 한다.
  const text = preview && preview.ts === selectedTs ? preview.text : null;
  const error = readError && readError.ts === selectedTs ? readError.message : null;
  const currentDoc = tab?.state.doc;
  const currentText = useMemo(() => currentDoc?.toString() ?? "", [currentDoc]);
  const large = useMemo(() => text !== null && (text.length + currentText.length > PREVIEW_LIMIT ||
    (currentDoc?.lines ?? 0) + text.split("\n").length > 12_000), [text, currentText, currentDoc]);
  const ops = useMemo(() => view === "diff" && text !== null && !large && text !== currentText
    ? diffLines(currentText, text) : [], [view, text, currentText, large]);
  const summary = useMemo(() => diffSummary(ops), [ops]);

  const select = (ts: number) => {
    if (busyRef.current) return;
    setSelectedTs(ts);
    setRestoreError(null);
  };
  const restore = async () => {
    if (busyRef.current || !targetValid || locked || !target.id || !target.path || !currentDoc || text === null) return;
    busyRef.current = true;
    // 클릭한 버튼이 disabled가 되어도 Esc 처리가 모달 밖으로 빠져나가지 않게 한다.
    overlayRef.current?.focus();
    setBusy(true);
    setRestoreError(null);
    try {
      await store.restoreVersion(target.id, target.path, currentDoc, text);
      if (alive.current) onRestored();
    } catch (error: unknown) {
      if (alive.current) setRestoreError(String(error));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div ref={overlayRef} className="overlay modal-overlay" role="dialog" aria-modal="true"
      aria-labelledby="versions-title" aria-describedby="versions-hint" aria-busy={busy} tabIndex={-1}
      onKeyDown={(event) => {
        if (imeComposing(event)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!busyRef.current) onClose();
        }
      }}
      onClick={(event) => { if (event.target === event.currentTarget && !busyRef.current) onClose(); }}>
      <div className="modal versions-modal">
        <div className="modal-title" id="versions-title">
          {t.versionsTitle}<span className="modal-file-name">{target.title}</span>
        </div>
        <p className="versions-hint" id="versions-hint">
          {t.versionsRestoreHint} {state.settings.autosave ? t.versionsAutosaveHint : t.versionsManualSaveHint}
        </p>
        {!targetValid && <p role="alert" className="versions-hint">{t.versionsTargetChanged}</p>}
        {locked && <p role="alert" className="versions-hint">{t.lockedNoEdit}</p>}
        <div className="versions-body">
          <div className="versions-sidebar">
            {listError ? <div className="palette-empty" role="alert">
              {t.versionsLoadFailed}<p>{listError}</p>
              <button className="btn" onClick={() => setListAttempt((value) => value + 1)}>{t.wsRetry}</button>
            </div> : items === null ? <div className="palette-empty" role="status">{t.versionsLoading}</div>
              : items.length === 0 ? <div className="palette-empty">{target.path ? t.versionsEmpty : t.emptyNoDoc}</div> : null}
            <div className="versions-list" ref={listRef} role="listbox" aria-label={t.versionsTitle}
              onKeyDown={(event) => {
                if (imeComposing(event) || !items?.length) return;
                const index = items.findIndex((item) => item.ts === selectedTs);
                let next: number;
                if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
                else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = items.length - 1;
                else return;
                event.preventDefault();
                if (busyRef.current) return;
                select(items[next].ts);
                const button = listRef.current?.querySelector<HTMLButtonElement>(`[data-ts="${items[next].ts}"]`);
                button?.focus();
                button?.scrollIntoView({ block: "nearest" });
              }}>
              {items?.map((item) => (
                <button key={item.ts} data-ts={item.ts} role="option" aria-selected={item.ts === selectedTs}
                  tabIndex={item.ts === selectedTs ? 0 : -1} disabled={busy}
                  title={new Date(item.ts).toLocaleString()}
                  className={`versions-item ${item.ts === selectedTs ? "is-sel" : ""}`}
                  onFocus={() => select(item.ts)} onClick={() => select(item.ts)}>
                  <span className="versions-time">{relTime(t, item.ts)}</span>
                  <span className="versions-size">{item.size.toLocaleString()} B</span>
                </button>
              ))}
            </div>
          </div>
          <div className="versions-preview" aria-busy={selectedTs !== null && text === null && !error}>
            <div className="versions-viewbar">
              <button className={`versions-viewbtn ${view === "diff" ? "is-on" : ""}`}
                aria-pressed={view === "diff"} onClick={() => setView("diff")}>
                {t.versionsViewDiff}
                {view === "diff" && text !== null && !large && <span className="diff-summary">
                  {" "}<span className="diff-add-c">+{summary.added}</span>{" "}<span className="diff-del-c">−{summary.removed}</span>
                </span>}
              </button>
              <button className={`versions-viewbtn ${view === "preview" ? "is-on" : ""}`}
                aria-pressed={view === "preview"} onClick={() => setView("preview")}>{t.versionsViewPreview}</button>
            </div>
            {error ? <div className="palette-empty" role="alert">
              {t.versionsReadFailed}<p>{error}</p>
              <button className="btn" onClick={() => { setReadError(null); setReadAttempt((value) => value + 1); }}>{t.wsRetry}</button>
            </div> : text === null ? <div className="palette-empty" role="status">
              {selectedTs === null ? t.versionsPick : t.versionsLoading}
            </div> : large ? <>
              <p className="versions-hint">{t.versionsLargePreview}</p>
              <pre tabIndex={0}>{text.slice(0, PREVIEW_LIMIT)}{text.length > PREVIEW_LIMIT ? "\n…" : ""}</pre>
            </> : view === "diff" ? (
              text === currentText ? <div className="palette-empty">{t.diffSame}</div> :
                <div className="versions-diff" tabIndex={0}>
                  {ops.map((op, i) => <pre key={i} className={`diff-line diff-${op.kind}`}>
                    <span className="diff-gutter">{op.kind === "add" ? "+" : op.kind === "del" ? "−" : " "}</span>
                    <code>{op.text}</code>
                  </pre>)}
                </div>
            ) : <pre tabIndex={0}>{text}</pre>}
          </div>
        </div>
        {restoreError && <p role="alert" className="versions-hint">{t.versionsRestoreFailed} {restoreError}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>{t.close}</button>
          <button className="btn btn-primary"
            disabled={busy || !targetValid || locked || text === null || text === currentText}
            onClick={() => void restore()}>{busy ? t.versionsRestoring : t.versionsRestore}</button>
        </div>
      </div>
    </div>
  );
}
