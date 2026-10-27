// 모달 — 미저장 확인(창/탭 닫기)과 외부 변경 충돌 안내.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { AppStore, Tab } from "../app/store";
import type { Translate } from "../i18n";
import { pickSave } from "../api";
import { imeComposing } from "../app/ime";

export function CloseConfirm({
  store,
  t,
  targetIds,
  onDone,
  onDiscard,
  requestKey,
}: {
  store: AppStore;
  t: Translate;
  targetIds: string[] | null;
  onDone: (proceed: boolean) => void;
  onDiscard?: (ids: string[]) => void;
  requestKey?: unknown;
}): JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const scope = JSON.stringify(targetIds ? [...new Set(targetIds)].sort() : null);
  const owner = useRef({ scope, requestKey });
  const savingRef = useRef<object | null>(null);
  const done = useRef(false), mounted = useRef(true);
  if (owner.current.scope !== scope || owner.current.requestKey !== requestKey) {
    owner.current = { scope, requestKey }; done.current = false;
  }
  const targets = () => store.state.tabs.filter((tab) => !targetIds || targetIds.includes(tab.id));
  const dirtyTabs = state.tabs.filter((x) => x.dirty && (!targetIds || targetIds.includes(x.id)));
  const name = dirtyTabs[0]?.path?.split("/").pop() ?? t.untitled;
  const complete = (proceed: boolean) => {
    if (done.current || !mounted.current) return;
    done.current = true; onDone(proceed);
  };

  // 오버레이 자체 포커스 — Esc=취소(macOS 알림 관례: 취소 버튼과 동일).
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    savingRef.current = null; setSaving(false); setError(""); setProgress(null);
    overlayRef.current?.focus();
  }, [scope, requestKey]);

  const perform = async (discard: boolean) => {
    if (savingRef.current || done.current) return;
    const token = owner.current;
    const current = () => mounted.current && owner.current === token && !done.current;
    savingRef.current = token; setSaving(true); setError("");
    store.syncActiveState();
    const selected = targets(), dirty = selected.filter((tab) => tab.dirty);
    let discarded: string[] | null = null;
    try {
      if (discard) {
        const reviewed = selected.map((tab) => ({ tab, doc: tab.state.doc, path: tab.path }));
        const unchanged = () => current() && targets().length === reviewed.length && reviewed.every(({ tab, doc, path }) =>
          store.state.tabs.includes(tab) && tab.state.doc === doc && tab.path === path);
        const ids = dirty.map((tab) => tab.id);
        await store.discardDocuments(ids, unchanged);
        if (!current()) { store.restoreDiscardedDocuments(ids); return; }
        discarded = ids;
      } else {
        setProgress({ done: 0, total: dirty.length });
        for (let i = 0; i < dirty.length; i++) {
          const tab = dirty[i], doc = tab.state.doc, originalPath = tab.path;
          if (!current()) return;
          if (!store.state.tabs.includes(tab)) continue;
          const path = originalPath ?? await pickSave(`${t.untitled}.md`, "md");
          if (!current() || !path) return;
          if (!store.state.tabs.includes(tab) || tab.path !== originalPath || tab.state.doc !== doc) {
            setError(t.closeChanged); return;
          }
          if (!(await store.saveDocument(tab.id, path))) { if (current()) setError(t.saveFailed); return; }
          if (!current()) return;
          setProgress({ done: i + 1, total: dirty.length });
        }
        if (!(await store.flushDocStyles(targetIds ?? undefined))) { if (current()) setError(t.saveFailed); return; }
      }
      if (!current()) return;
      // A clean target can acquire edits while other documents are being saved.
      if (targets().some((tab) => tab.dirty)) {
        if (discarded) store.restoreDiscardedDocuments(discarded);
        setError(t.closeChanged); return;
      }
      if (discarded) onDiscard?.(discarded);
      complete(true);
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (savingRef.current === token) {
        savingRef.current = null;
        if (mounted.current) { setSaving(false); setProgress(null); }
      }
    }
  };

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="close-confirm-title"
      aria-describedby="close-confirm-description"
      aria-busy={saving}
      onKeyDown={(e) => {
        if (!imeComposing(e) && e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (!savingRef.current) complete(false);
        }
      }}
    >
      <div className="modal">
        <div className="modal-title" id="close-confirm-title">{t.dirtyTitle}</div>
        <p className="modal-text" id="close-confirm-description">
          {dirtyTabs.length ? `${t.dirtyQuoteBefore}${name}${dirtyTabs.length > 1 ? ` (+${dirtyTabs.length - 1})` : ""}${t.dirtyQuoteAfter}` : t.closeReady}
        </p>
        {dirtyTabs.length > 1 && <ul className="close-documents" aria-label={t.openTabs}>
          {dirtyTabs.map((tab, index) => <li key={tab.id}>{tab.path ?? `${t.untitled} ${index + 1}`}</li>)}
        </ul>}
        {progress && <p className="modal-hint" role="status">{t.dirtySave}: {progress.done}/{progress.total}</p>}
        {error && <p className="modal-text close-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button
            className="btn btn-primary"
            disabled={saving}
            onClick={() => { void perform(false); }}
          >
            {saving ? t.loading : dirtyTabs.length ? t.dirtySave : t.close}
          </button>
          <button className="btn" disabled={saving || !dirtyTabs.length} onClick={() => { void perform(true); }}>
            {t.dirtyDiscard}
          </button>
          <button className="btn btn-plain" disabled={saving} onClick={() => complete(false)}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConflictDialog({
  store,
  tab,
  t,
}: {
  store: AppStore;
  tab: Tab;
  t: Translate;
}): JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const busyRef = useRef<object | null>(null), mounted = useRef(true);
  const path = tab.path, conflict = tab.conflict;
  const owner = useRef({ id: tab.id, path, conflict });
  if (owner.current.id !== tab.id || owner.current.path !== path || owner.current.conflict !== conflict) {
    owner.current = { id: tab.id, path, conflict };
  }
  const removed = conflict === "removed";
  const name = tab.path?.split("/").pop() ?? t.untitled;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    busyRef.current = null; setBusy(false); setError("");
    overlayRef.current?.focus();
  }, [tab.id, path, conflict]);

  const resolve = async (action: "reload" | "keep" | "copy") => {
    if (busyRef.current || !conflict) return;
    const token = owner.current;
    const current = () => mounted.current && owner.current === token && store.state.tabs.includes(tab) &&
      tab.path === path && tab.conflict === conflict;
    if (!current()) return;
    busyRef.current = token; setBusy(true); setError("");
    try {
      if (action === "copy") {
        store.syncActiveState();
        const doc = tab.state.doc;
        const destination = await pickSave(`${name.replace(/\.(md|markdown)$/i, "")}-copy.md`, "md");
        if (!current() || !destination) return;
        store.syncActiveState();
        if (tab.state.doc !== doc) { setError(t.extResolutionChanged); return; }
        if (destination === path) { setError(t.extCopyDifferentPath); return; }
        const unchanged = () => current() && tab.state.doc === doc;
        const saved = await store.saveDocument(tab.id, destination, unchanged);
        if (!saved && current()) setError(unchanged() ? t.saveFailed : t.extResolutionChanged);
      } else {
        const result = action === "reload" ? await store.reloadTab(tab.id, true, current) : await store.keepMine(tab.id, current);
        if (!current()) return;
        if (result.status === "failed") setError(result.message);
        else if (result.status === "changed") setError(t.extResolutionChanged);
      }
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (busyRef.current === token) {
        busyRef.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  };

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t.extChangedTitle}
      aria-busy={busy}
      aria-describedby="conflict-description"
      onKeyDown={(e) => {
        if (!imeComposing(e) && e.key === "Escape") {
          e.preventDefault(); e.stopPropagation();
          if (!removed && !busyRef.current && !e.repeat) void resolve("keep");
        }
      }}
    >
      <div className="modal conflict-modal">
        <div className="modal-title">{t.extChangedTitle}</div>
        <p className="modal-text" id="conflict-description">
          {removed ? t.extRemoved : t.extChangedConflict}
          <br />
          <code className="modal-file">{path ?? name}</code>
        </p>
        <div className="modal-actions">
          {!removed && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => { void resolve("reload"); }}
            >
              {t.extReload}
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => { void resolve("keep"); }}>
            {removed ? t.extKeepRemoved : t.extKeepMine}
          </button>
          <button className="btn" disabled={busy} onClick={() => { void resolve("copy"); }}>{t.extSaveCopy}</button>
        </div>
        <p className="modal-hint">{removed ? t.extKeepRemovedHint : t.extKeepMineHint}</p>
        {!removed && <p className="modal-hint">{t.extReloadBackupHint}</p>}
        {busy && <p className="modal-hint" role="status">{t.loading}</p>}
        {error && <p className="modal-text close-error" role="alert">{error}</p>}
      </div>
    </div>
  );
}
