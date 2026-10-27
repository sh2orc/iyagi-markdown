import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, isInApp, type LinkInspection } from "../api";
import type { AppStore, Tab } from "../app/store";

type Target = { id: string; path: string | null; doc: Tab["state"]["doc"]; root: string; revision: number };

export function useLinkInspection(store: AppStore) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const tab = store.active;
  const [result, setResult] = useState<{ target: Target; data: LinkInspection } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const requestRef = useRef<Promise<void> | null>(null);
  const current = (target: Target) => {
    const active = store.active;
    return !!active && active.id === target.id && active.path === target.path &&
      active.state.doc === target.doc && store.state.workspace === target.root &&
      store.state.linksRevision === target.revision;
  };
  useEffect(() => {
    setResult(null); setError(null);
    if (!tab || !state.workspace) { setLoading(false); return; }
    if (!isInApp()) { setLoading(false); setError("Link inspection requires the desktop app."); return; }
    const target: Target = { id: tab.id, path: tab.path, doc: tab.state.doc,
      root: state.workspace, revision: state.linksRevision };
    let disposed = false;
    const valid = () => !disposed && current(target);
    setLoading(true);
    const timer = setTimeout(() => {
      const previous = requestRef.current;
      const request = (async () => {
        await previous;
        if (!valid()) return;
        try {
          const data = await api.inspectLinks(target.root, target.path, target.doc.toString());
          if (valid()) setResult({ target, data });
        } catch (reason) { if (valid()) setError(String(reason)); }
        finally { if (valid()) setLoading(false); }
      })();
      requestRef.current = request;
      void request.then(() => { if (requestRef.current === request) requestRef.current = null; });
    }, 250);
    return () => { disposed = true; clearTimeout(timer); };
  }, [tab?.id, tab?.path, tab?.state.doc, state.workspace, state.linksRevision, reload]);
  return { result: result && current(result.target) ? result : null, error, loading,
    current, retry: () => setReload((n) => n + 1), workspace: state.workspace, hasDocument: !!tab };
}
