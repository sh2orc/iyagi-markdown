import { useState, useSyncExternalStore } from "react";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import { dirname } from "../paths";

/** 시작 화면과 사이드바가 같은 서버 목록·오류·변경 상태를 사용한다. */
export function RecentDocuments({ store, t, limit = 8 }: {
  store: AppStore; t: Translate; limit?: number;
}): JSX.Element | null {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  if (!state.recent.length && !state.recentError && !state.recentLoading) return null;
  return <section className="recent-documents" aria-label={t.recentSection} aria-busy={state.recentLoading || state.recentBusy}>
    <div className="recent-heading">
      <span className="sidebar-subtitle">{t.recentSection}</span>
      {state.recent.length > 0 && <button className="recent-action" disabled={state.recentBusy}
        title={t.recentClearHint} onClick={() => void store.clearRecent()}>{t.recentClear}</button>}
    </div>
    {state.recentLoading && <p className="recent-status" role="status">{t.recentLoading}</p>}
    {state.recentError && <div className="recent-status" role="alert">
      <p>{t.recentFailed} {state.recentError}</p>
      <button className="recent-action" disabled={state.recentLoading || state.recentBusy}
        onClick={() => void store.loadRecent()}>{t.wsRetry}</button>
    </div>}
    <ul className="recent-list">
      {state.recent.slice(0, expanded ? state.recent.length : limit).map((entry) => <li className="recent-row" key={entry.path}>
        <button className={`recent-open ${store.active?.path === entry.path ? "is-active" : ""}`}
          title={entry.path} onClick={() => void store.openPath(entry.path)}>
          <span>{entry.name}</span>
          <span className="recent-path">{dirname(entry.path)}</span>
        </button>
        <button className="recent-remove" disabled={state.recentBusy}
          aria-label={`${t.recentRemove}: ${entry.name}`} title={t.recentRemove}
          onClick={() => void store.removeRecent(entry.path)}>×</button>
      </li>)}
    </ul>
    {state.recent.length > limit && <button className="recent-action recent-expand" aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}>{expanded ? t.recentShowLess : t.recentShowAll}</button>}
  </section>;
}
