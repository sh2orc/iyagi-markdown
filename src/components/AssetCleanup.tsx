import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, isInApp, type AssetTrashReport, type OrphanAsset } from "../api";
import type { AppStore, Tab } from "../app/store";
import type { Translate } from "../i18n";

type BufferVersion = { id: string; path: string | null; doc: Tab["state"]["doc"] };
function bufferVersions(store: AppStore): BufferVersion[] {
  return store.state.tabs.map((tab) => ({ id: tab.id, path: tab.path, doc: tab.state.doc }));
}
function sameBuffers(store: AppStore, versions: BufferVersion[]): boolean {
  return versions.length === store.state.tabs.length && versions.every((version) => {
    const tab = store.state.tabs.find((item) => item.id === version.id);
    return tab?.path === version.path && tab?.state.doc === version.doc;
  });
}

export function AssetCleanup({ store, t, onBusyChange }: {
  store: AppStore; t: Translate; onBusyChange: (busy: boolean) => void;
}): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const root = state.workspace;
  const [result, setResult] = useState<{ root: string; docs: BufferVersion[]; items: OrphanAsset[] } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [armed, setArmed] = useState(false);
  const [report, setReport] = useState<AssetTrashReport | null>(null);
  const alive = useRef(true);
  const section = useRef<HTMLElement | null>(null);
  const valid = result !== null && result.root === root && sameBuffers(store, result.docs);
  const message = (error: unknown) => String(error) === "ASSET_CLEANUP_OTHER_WINDOWS" ? t.reviewOtherWindows : String(error);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    setResult(null);
    setSelected(new Set());
    setArmed(false);
    setReport(null);
    setError(null);
    if (!root || !isInApp()) { setLoading(false); return; }
    let disposed = false;
    const docs = bufferVersions(store);
    setLoading(true);
    void api.findOrphanImages(root, docs.map((entry) => entry.doc.toString())).then((items) => {
      if (!disposed) setResult({ root, docs, items });
    }).catch((error: unknown) => {
      if (!disposed) setError(String(error));
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [root, revision, store]);

  const apply = async () => {
    if (busyRef.current || !result || !valid || selected.size === 0) return;
    if (!armed) { setArmed(true); return; }
    // 이벤트 핸들러에 들어온 순간의 문서 상태도 다시 확인한다.
    if (store.state.workspace !== result.root || !sameBuffers(store, result.docs)) return;
    busyRef.current = true;
    setBusy(true);
    onBusyChange(true);
    section.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
    setError(null);
    setArmed(false);
    try {
      const report = await api.deleteOrphanImages(result.root,
        result.items.filter((item) => selected.has(item.path)), result.docs.map((entry) => entry.doc.toString()));
      if (!alive.current) return;
      setReport(report);
      const moved = new Set(report.moved);
      setResult({ ...result, items: result.items.filter((item) => !moved.has(item.path)) });
      setSelected(new Set());
    } catch (error: unknown) {
      if (alive.current) setError(message(error));
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(false); onBusyChange(false); }
    }
  };

  const changeSelection = (paths: Set<string>) => {
    if (busyRef.current) return;
    setSelected(paths);
    setArmed(false);
  };
  const relative = (path: string) => root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const size = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : bytes >= 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${bytes} B`;

  return <section className="review-card review-card-wide" ref={section} aria-busy={loading || busy}>
    <h3>{t.reviewOrphans}</h3>
    <p className="review-ok">{t.reviewOrphanScope}</p>
    {!root && <p className="review-ok">{t.reviewNeedsWorkspace}</p>}
    {loading && <p role="status">{t.reviewScanning}</p>}
    {error && <p className="review-error" role="alert">{t.reviewOrphanFail} {error}</p>}
    {result && !valid && <p className="review-error" role="status">{t.reviewScanStale}</p>}
    {report && <div className="review-report" role="status">
      <p>{t.f.reviewOrphanDone(report.moved.length)}</p>
      {report.moved.length > 0 && <details><summary>{t.reviewMovedFiles}</summary>
        <ul>{report.moved.map((path) => <li key={path}>{relative(path)}</li>)}</ul>
      </details>}
      {report.failed.length > 0 && <><p>{t.reviewPartial}</p><ul>
        {report.failed.map((failure) => <li key={failure.path}>{relative(failure.path)} — {message(failure.message)}</li>)}
      </ul></>}
    </div>}
    {result && valid && result.items.length === 0 && !report && <p className="review-ok">{t.reviewOrphanNone}</p>}
    {result && result.items.length > 0 && <>
      <label className="review-select-all"><input type="checkbox" disabled={busy || !valid}
        checked={selected.size === result.items.length}
        onChange={(event) => changeSelection(event.target.checked ? new Set(result.items.map((item) => item.path)) : new Set())} />
        {t.reviewSelectAll} ({result.items.length})
      </label>
      <ul className="review-orphans">
        {result.items.map((item) => <li key={item.path}>
          <label title={item.path}>
            <input type="checkbox" disabled={busy || !valid} checked={selected.has(item.path)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(item.path); else next.delete(item.path);
                changeSelection(next);
              }} />
            <span className="review-orphan-name">{relative(item.path)}</span>
            <span className="review-orphan-size">{size(item.size)}</span>
          </label>
        </li>)}
      </ul>
      {armed && valid && <p className="review-ok" role="status">{t.reviewTrashConfirm}</p>}
      <div className="review-cleanup-actions">
        <button className="btn btn-danger" disabled={busy || !valid || selected.size === 0} onClick={() => void apply()}>
          {busy ? t.reviewMoving : armed ? t.f.reviewOrphanDelete(selected.size) : t.f.reviewSelection(selected.size)}
        </button>
        {armed && <button className="btn" disabled={busy} onClick={() => setArmed(false)}>{t.cancel}</button>}
      </div>
    </>}
    {root && <button className="btn" disabled={busy || loading} onClick={() => setRevision((value) => value + 1)}>{t.reviewRescan}</button>}
  </section>;
}
