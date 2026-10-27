// 추적 기준 변경은 확인한 문서 스냅샷에만 적용한다.
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AppStore, TrackingTarget } from "../app/store";
import { hunksOf, type TrackHunk } from "../editor/trackChanges";
export { hunksOf, revertChange } from "../editor/trackChanges";
export type { TrackHunk as Hunk } from "../editor/trackChanges";
import { smoothScrollIntoView } from "../editor/cm";
import { imeComposing } from "../app/ime";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  initialAction?: "start" | "accept" | "stop" | null;
}

export function TrackPanel({ store, t, onClose, initialAction }: Props): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [target] = useState(() => ({ id: store.active?.id ?? "", path: store.active?.path ?? "", title: store.active?.title ?? t.untitled }));
  const tab = state.tabs.find((item) => item.id === target.id && item.path === target.path);
  const valid = !!tab && state.activeId === target.id;
  const [confirmation, setConfirmation] = useState<{ action: "accept" | "stop"; target: TrackingTarget } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workingRef = useRef(false);
  const initialized = useRef(false);
  const alive = useRef(true);
  const overlay = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const doc = tab?.state.doc;
  const baseline = tab?.baselineText;
  const hunks = useMemo(() => baseline != null && doc ? hunksOf(baseline, doc.toString()) : [], [baseline, doc]);
  const busy = working || !!tab?.baselineBusy;
  const ready = valid && !!tab?.baselineLoaded && !tab.baselineLoading && !busy;
  const locked = !tab || store.lockedTabIds.has(tab.id) || tab.mode === "read";

  useEffect(() => {
    alive.current = true; overlay.current?.focus();
    void store.refreshBaseline(target.path);
    return () => { alive.current = false; };
  }, [store, target.path]);
  useEffect(() => {
    if (initialized.current || !ready) return;
    initialized.current = true;
    if ((initialAction === "accept" || initialAction === "stop") && baseline != null && doc) {
      setConfirmation({ action: initialAction, target: { ...target, doc, baseline } });
    }
  }, [ready, baseline, doc, initialAction, target]);

  const close = () => { if (!workingRef.current && !tab?.baselineBusy) onClose(); };
  const request = (action: "accept" | "stop") => {
    if (!ready || !doc || baseline == null) return;
    setError(null);
    setConfirmation({ action, target: { ...target, doc, baseline } });
  };
  const apply = async (action: "start" | "accept" | "stop", selected: TrackingTarget) => {
    if (workingRef.current) return;
    workingRef.current = true; setWorking(true); setError(null);
    try {
      const ok = action === "start" ? await store.startTracking(selected)
        : action === "accept" ? await store.acceptAllChanges(selected) : await store.stopTracking(selected);
      if (alive.current) {
        if (ok) setConfirmation(null);
        else setError(t.trackSaveFailed);
      }
    } catch (cause) {
      if (alive.current) setError(String(cause));
    } finally { workingRef.current = false; if (alive.current) setWorking(false); }
  };
  const revert = (hunk: TrackHunk) => {
    const view = store.view;
    if (!ready || !view || !doc || baseline == null || locked) return;
    if (store.revertTrackingHunk(view, doc, baseline, hunk, target.id)) store.toast(t.trackReverted);
    else setError(t.trackTargetChanged);
  };
  const goto = (line: number) => {
    const view = store.view;
    if (!valid || !view || view.state.doc !== doc) return;
    const position = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines)).from;
    view.dispatch({ selection: { anchor: position } }); smoothScrollIntoView(view, position);
  };

  return (
    <div ref={overlay} tabIndex={-1} className="overlay modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
      onKeyDown={(event) => {
        if (imeComposing(event)) return;
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation();
          if (confirmation && !busy) setConfirmation(null); else close();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && (event.target as HTMLElement).classList.contains("track-goto")) {
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".track-goto")];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
          buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
        }
      }}>
      <div className="modal track-modal" aria-busy={busy || tab?.baselineLoading}>
        <div className="modal-title" id={titleId}>{t.trackPanelTitle}<span className="modal-file-name">{target.title}</span></div>
        {!valid && <p className="comment-error" role="alert">{target.path ? t.trackTargetChanged : t.commentSaveDocument}</p>}
        {tab?.baselineLoading && <p className="review-ok" role="status">{t.loading}</p>}
        {tab?.baselineError && <div className="comment-error" role="alert">{t.trackLoadFailed}: {tab.baselineError}
          <button className="btn" disabled={busy || tab.baselineLoading} onClick={() => {
            setConfirmation(null); setError(null); void store.refreshBaseline(target.path);
          }}>{t.wsRetry}</button>
        </div>}
        {error && <p className="comment-error" role="alert">{error}</p>}
        {tab?.baselineLoaded && !tab.baselineLoading && !tab.baselineError && baseline == null && <p className="review-ok">{t.trackNotActive}</p>}
        {tab?.baselineLoaded && !tab.baselineLoading && !tab.baselineError && baseline != null && !hunks.length && <p className="review-ok">{t.trackNoChanges}</p>}
        {!!hunks.length && <ul className="track-list" aria-label={t.trackPanelTitle}>
          {hunks.map((hunk, index) => <li key={index} className={`track-item track-${hunk.kind}`}>
            <button className="track-goto" disabled={!valid || busy || !!confirmation} onClick={() => goto(hunk.line)}>
              <span className="track-badge">{hunk.kind === "add" ? `+${hunk.lines}` : `−${hunk.lines}`}</span>
              <span className="track-line">{t.f.lineAt(hunk.line)}</span><span className="track-text">{hunk.preview}</span>
            </button>
            <button className="track-revert" title={t.trackRevert} aria-label={t.trackRevert}
              disabled={!ready || locked || !!confirmation} onClick={() => revert(hunk)}>↺</button>
          </li>)}
        </ul>}
        {confirmation && <div className="comment-error" role="alert">
          <p>{confirmation.action === "accept" ? t.trackAcceptPrompt : t.trackStopPrompt}</p>
          <button className="btn" disabled={!ready} onClick={() => void apply(confirmation.action, confirmation.target)}>
            {confirmation.action === "accept" ? t.trackAccept : t.trackStop}
          </button>
          <button className="btn btn-plain" disabled={busy} onClick={() => setConfirmation(null)}>{t.cancel}</button>
        </div>}
        <div className="modal-actions">
          {!confirmation && (baseline == null ? <button className="btn" disabled={!ready} onClick={() => {
            if (doc) void apply("start", { ...target, doc, baseline: null });
          }}>{t.trackStart}</button> : <>
            <button className="btn" disabled={!ready || !hunks.length} onClick={() => request("accept")}>{t.trackAccept}</button>
            <button className="btn btn-plain" disabled={!ready} onClick={() => request("stop")}>{t.trackStop}</button>
          </>)}
          <button className="btn btn-primary" disabled={busy} onClick={close}>{t.done}</button>
        </div>
      </div>
    </div>
  );
}
