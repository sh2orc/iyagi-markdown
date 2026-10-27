import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type ReplacementPreview, type ReplacementReport, type PendingRename } from "../api";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";

export type RenamedDocument = PendingRename;

export function RenameLinksReview({ store, target, t, onClose }: {
  store: AppStore; target: RenamedDocument; t: Translate; onClose: (complete: boolean) => void;
}): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [preview, setPreview] = useState<ReplacementPreview | null>(null);
  const [report, setReport] = useState<ReplacementReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const busyRef = useRef(false);
  const sequence = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const prepare = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setPreview(null); setReport(null);
    const version = ++sequence.current;
    try {
      const next = await api.previewWikiRename(target.id);
      if (sequence.current === version) setPreview(next);
    } catch (e) { if (sequence.current === version) setError(String(e)); }
    finally {
      if (sequence.current === version) {
        busyRef.current = false; setBusy(false);
        requestAnimationFrame(() => closeRef.current?.focus());
      }
    }
  };
  useEffect(() => {
    void prepare();
    return () => { ++sequence.current; busyRef.current = false; };
  }, [target.id, target.root, target.from, target.to]);
  const blocked = (paths: Set<string>) => store.state.tabs.some((tab) => tab.path && paths.has(tab.path) &&
    (tab.dirty || tab.conflict !== null || store.lockedTabIds.has(tab.id)));
  // Snapshot subscription keeps the button in sync; recheck live state at submission too.
  const paths = new Set(preview?.files.map((file) => file.path) ?? []);
  const dirtyBlocked = state.tabs.length > 0 && blocked(paths);
  const complete = !!report && report.failed.length === 0 || !!preview && preview.files.length === 0 && preview.skipped.length === 0;
  const close = async () => {
    if (busyRef.current) return;
    if (!complete) { onClose(false); return; }
    busyRef.current = true; setBusy(true); setError(null);
    const version = ++sequence.current;
    try {
      // Do not forget the saved job until its acknowledgement is durable.
      await api.finishRenameReview(target.id);
      if (sequence.current === version) onClose(true);
    } catch (e) { if (sequence.current === version) setError(`${t.renameJobsFinishFailed}: ${String(e)}`); }
    finally { if (sequence.current === version) { busyRef.current = false; setBusy(false); } }
  };
  const apply = async () => {
    if (busyRef.current || !preview?.files.length) return;
    store.syncActiveState();
    if (blocked(new Set(preview.files.map((file) => file.path)))) { setError(t.renameLinksBlocked); return; }
    busyRef.current = true; setBusy(true); setError(null);
    const version = ++sequence.current;
    try {
      const result = await api.applyReplacement(preview.id);
      for (const file of result.applied) store.externalChange(file.path, "changed");
      if (sequence.current === version) { setReport(result); setPreview(null); }
    } catch (e) {
      if (sequence.current === version) { setError(String(e) === "REPLACEMENT_PREVIEW_EXPIRED" ? t.wsPreviewExpired : String(e)); setPreview(null); }
    } finally {
      if (sequence.current === version) { busyRef.current = false; setBusy(false); }
    }
  };
  return <div className="overlay modal-overlay" role="dialog" aria-modal="true" aria-labelledby="rename-links-title"
    onClick={(e) => { if (e.target === e.currentTarget) void close(); }}
    onKeyDown={(e) => {
      if (!imeComposing(e) && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); void close(); }
    }}>
    <div className="modal rename-links-review" aria-busy={busy}>
      <h2 id="rename-links-title" className="modal-title">{t.renameLinksReview}</h2>
      <p>{t.renameLinksRenamed}</p>
      <p className="rename-links-path">{target.from} → {target.to}</p>
      <p>{t.wsPreviewHint}</p>
      {busy && <p role="status">{t.loading}</p>}
      {error && <p role="alert" className="rename-error">{error}</p>}
      {preview && <>
        <p>{t.f.wsPreviewCount(preview.files.length, preview.files.reduce((n, file) => n + file.count, 0))}</p>
        {dirtyBlocked && <p role="alert">{t.renameLinksBlocked}</p>}
        {!preview.files.length && <p>{t.wsNoChanges}</p>}
        <div className="wssearch-review-list">
          {preview.files.map((file) => <div className="wssearch-change" key={file.path}>
            <strong>{file.path} · {file.count}</strong>
            <pre className="wssearch-before">− {file.before}</pre><pre className="wssearch-after">+ {file.after}</pre>
          </div>)}
          {preview.skipped.length > 0 && <><strong>{t.wsSkipped}</strong>{preview.skipped.map((file, i) =>
            <p key={`${file.path}-${i}`}>{file.path}: {file.message}</p>)}</>}
        </div>
      </>}
      {report && <div role="status">
        <p>{t.f.wsReplaceDone(report.applied.length, report.applied.reduce((n, file) => n + file.count, 0))}</p>
        {report.applied.length > 0 && <details><summary>{t.wsAppliedFiles}</summary><div className="wssearch-review-list">
          {report.applied.map((file) => <p key={file.path}>{file.path} · {file.count}</p>)}
        </div></details>}
        {report.failed.length > 0 && <><p>{t.wsPartial}</p><div className="wssearch-review-list">
          {report.failed.map((file, i) => <p key={`${file.path}-${i}`}>{file.path}: {file.message}</p>)}
        </div></>}
      </div>}
      <div className="modal-actions">
        <button className="btn" disabled={busy} onClick={() => void prepare()}>{t.wsPreview}</button>
        {preview && <button className="btn btn-primary" disabled={busy || dirtyBlocked || !preview.files.length}
          onClick={() => void apply()}>{t.wsApply}</button>}
        {error && complete && <button className="btn btn-plain" disabled={busy} onClick={() => onClose(false)}>{t.renameJobsKeepPending}</button>}
        <button ref={closeRef} className="btn btn-plain" disabled={busy} onClick={() => void close()}>{t.close}</button>
      </div>
    </div>
  </div>;
}
