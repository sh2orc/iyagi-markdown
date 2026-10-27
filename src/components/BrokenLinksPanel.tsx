import { useEffect, useRef, useState } from "react";
import { api, type MissingLink } from "../api";
import type { AppStore } from "../app/store";
import { imeComposing } from "../app/ime";
import type { Translate } from "../i18n";
import { useLinkInspection } from "./useLinkInspection";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onGoto: (from: number) => void;
}

export function BrokenLinksPanel({ store, t, onClose, onGoto }: Props): JSX.Element {
  const inspection = useLinkInspection(store);
  const { result, loading, error } = inspection;
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const overlay = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const links = result?.data.links ?? [];
  useEffect(() => {
    alive.current = true; overlay.current?.focus();
    return () => { alive.current = false; };
  }, []);
  useEffect(() => { setSel(0); }, [result]);
  useEffect(() => { rows.current?.children[sel]?.scrollIntoView({ block: "nearest" }); }, [sel]);
  const close = () => { if (!busyRef.current) onClose(); };
  const valid = () => {
    store.syncActiveState();
    if (!result || !inspection.current(result.target)) {
      setCreateError(t.brokenTargetChanged); return false;
    }
    return true;
  };
  const go = (link: MissingLink) => {
    if (busyRef.current || !valid()) return;
    onClose(); onGoto(link.from);
  };
  const create = async (link: MissingLink) => {
    if (busyRef.current || !link.createPath || !valid() || !result) return;
    const target = result.target;
    busyRef.current = true; setBusy(true); setCreateError(null);
    try {
      const path = await api.createLinkDocument(target.root, target.path, link.kind, link.name);
      // Opening is conditional; successful creation remains true even after navigation.
      const active = store.active;
      const stay = alive.current && store.state.workspace === target.root &&
        !!active && active.id === target.id && active.path === target.path && active.state.doc === target.doc;
      if (store.state.workspace === target.root) void store.refreshTree();
      store.toast(`${t.brokenCreated}: ${path}`);
      if (stay) { onClose(); await store.openPath(path); }
    } catch (reason) { if (alive.current) setCreateError(`${link.createPath}: ${String(reason)}`); }
    finally { busyRef.current = false; if (alive.current) { setBusy(false); inspection.retry(); } }
  };
  return <div ref={overlay} className="overlay palette-overlay" role="dialog" aria-modal="true"
    aria-labelledby="broken-links-title" tabIndex={-1}
    onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    onKeyDown={(e) => {
      if (imeComposing(e)) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if ((e.target as HTMLElement).closest("button, summary") || busyRef.current) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); setSel((n) => Math.max(0, Math.min(links.length - 1, n + (e.key === "ArrowDown" ? 1 : -1))));
      } else if (e.key === "Enter" && links[sel]) { e.preventDefault(); go(links[sel]); }
      else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "c" && links[sel]?.createPath) {
        e.preventDefault(); void create(links[sel]);
      }
    }}>
    <div className="palette wssearch" aria-busy={busy || loading}>
      <div className="wssearch-heading">
        <strong id="broken-links-title">{t.brokenLinksTitle}</strong>
        {result && <span className="wssearch-count">{links.length}</span>}
        <button className="btn btn-plain" disabled={busy} onClick={close}>{t.close}</button>
      </div>
      <p className="wssearch-status">{t.brokenScope}</p>
      {(busy || loading) && <p className="wssearch-status" role="status">{t.loading}</p>}
      {(error || createError) && <div className="wssearch-status" role="alert">
        <p>{createError ?? `${t.brokenCheckFailed}: ${error}`}</p>
        <button className="btn" disabled={busy} onClick={() => { setCreateError(null); inspection.retry(); }}>{t.wsRetry}</button>
      </div>}
      {result && result.data.issues.length > 0 && <details className="wssearch-status">
        <summary>{t.brokenUnverified}</summary>
        {result.data.issues.slice(0, 50).map((issue, i) => <p key={i}>{issue.path}: {issue.message}</p>)}
        {result.data.issues.length > 50 && <p>{t.workspaceMoreIssues}</p>}
      </details>}
      <div ref={rows} className="palette-list">
        {!loading && !error && !links.length && <div className="palette-empty">
          {!inspection.workspace ? t.wsSearchNoFolder : !inspection.hasDocument ? t.emptyNoDoc
            : result?.data.issues.length ? t.brokenNoneVerified : result ? t.brokenLinksNone : t.loading}
        </div>}
        {links.map((link, i) => <div key={`${link.from}-${link.kind}`} className="broken-link-row"
          onMouseEnter={() => setSel(i)}>
          <button className={`palette-item wssearch-hit ${i === sel ? "is-sel" : ""}`} disabled={busy} onClick={() => go(link)}>
            <span className="wssearch-lineno">{link.line}</span>
            <span className="wssearch-text">{link.kind === "wiki" ? `[[${link.name}]]` : link.name}</span>
          </button>
          {link.createPath && <button className="btn broken-create" disabled={busy}
            title={link.createPath} aria-label={`${t.brokenCreate}: ${link.name}`}
            onClick={() => void create(link)}>＋</button>}
        </div>)}
      </div>
    </div>
  </div>;
}
