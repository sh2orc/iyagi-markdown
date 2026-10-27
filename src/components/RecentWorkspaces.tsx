import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";

export function RecentWorkspaces({ store, t, query = "", limit = 4 }: {
  store: AppStore; t: Translate; query?: string; limit?: number;
}): JSX.Element | null {
  const history = useSyncExternalStore(store.workspaceHistory.subscribe, store.workspaceHistory.getSnapshot);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const section = useRef<HTMLElement | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const previousFocus = useRef<{ path: string; index: number; element: HTMLElement } | null>(null);
  const wasBusy = useRef(false);
  const needle = query.trim().normalize("NFC").toLocaleLowerCase();
  const matches = history.entries.filter((entry) => entry.path.normalize("NFC").toLocaleLowerCase().includes(needle));
  const visible = matches.slice(0, expanded || needle ? matches.length : limit);
  const key = visible.map((entry) => entry.path).join("\0");
  useLayoutEffect(() => {
    const previous = previousFocus.current;
    const finished = wasBusy.current && !history.busy;
    wasBusy.current = history.busy;
    if (!previous) return;
    if (previous.path === "" && history.busy) return;
    if (previous.path === "" && finished && previous.element.isConnected) {
      if (document.activeElement === document.body) previous.element.focus();
      previousFocus.current = null; return;
    }
    const index = visible.findIndex((entry) => entry.path === previous.path);
    if (index >= 0) {
      previous.index = index;
      if (finished && previous.element.isConnected && document.activeElement === document.body) previous.element.focus();
      return;
    }
    previousFocus.current = null;
    const active = document.activeElement;
    if (active !== previous.element && active !== document.body && active?.isConnected) return;
    const next = visible[Math.min(previous.index, visible.length - 1)];
    (next ? buttons.current.get(next.path) : section.current)?.focus();
  }, [key, history.busy]);
  if (!history.loaded && !history.loading && !history.error) return null;
  return <section ref={section} tabIndex={-1} className="recent-documents recent-workspaces" aria-label={t.workspaceRecent} aria-busy={history.loading || history.busy}>
    <div className="recent-heading">
      <span className="sidebar-subtitle">{t.workspaceRecent}</span>
      {history.entries.length > 0 && <button className="recent-action" disabled={history.busy || history.loading}
        title={t.workspaceHistoryClearHint} onClick={(event) => {
          previousFocus.current = { path: "", index: 0, element: event.currentTarget };
          void store.workspaceHistory.clear();
        }}>{t.recentClear}</button>}
    </div>
    {history.loading && <p role="status" className="recent-status">{t.loading}</p>}
    {history.error && <div role="alert" className="recent-status"><p>{t.workspaceHistoryFailed} {history.error}</p>
      <button className="recent-action" disabled={history.loading || history.busy} onClick={() => void store.workspaceHistory.load()}>{t.wsRetry}</button>
    </div>}
    {!history.entries.length && !history.loading && !history.error && <p className="recent-status">{t.workspaceHistoryEmpty}</p>}
    <ul className="recent-list">
      {visible.map((entry, index) => <li className="recent-row" key={entry.path} onFocus={(event) => {
        previousFocus.current = { path: entry.path, index, element: event.target as HTMLElement };
      }}>
        <button className={`recent-open ${state.workspace === entry.path ? "is-active" : ""}`} title={entry.path}
          aria-current={state.workspace === entry.path ? "location" : undefined}
          disabled={state.workspace === entry.path && state.workspaceLoading}
          ref={(node) => { if (node) buttons.current.set(entry.path, node); else buttons.current.delete(entry.path); }}
          onClick={() => void store.openWorkspace(entry.path)}>
          <span>{entry.name}</span><span className="recent-path">{entry.path}</span>
        </button>
        <button className="recent-remove" disabled={history.busy || history.loading} title={t.workspaceHistoryRemoveHint}
          aria-label={`${t.recentRemove}: ${entry.path}`} onClick={() => void store.workspaceHistory.remove(entry.path)}>×</button>
      </li>)}
    </ul>
    {!needle && matches.length > limit && <button className="recent-action recent-expand" aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}>{expanded ? t.recentShowLess : t.recentShowAll}</button>}
    {state.workspaceError && visible.some((entry) => entry.path === state.workspace) && <p role="status" className="recent-status">{t.workspaceHistoryOpenFailed}</p>}
  </section>;
}
