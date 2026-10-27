// Search drafts stay mounted; timers and confirmations belong to one tab/query.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import { askDialog } from "../api";
import { imeComposing } from "../app/ime";
import { applyReplaceAll, findNext, gotoMatch, prepareReplaceAll, replaceCurrent,
  sameSearch, searchStateOf, setSearchState, subscribeSearch, validSearchQuery, type SearchQuery,
} from "../search/searchCm";
import { SearchWorkError, type SearchFailure } from "../search/searchWork";

interface Props { store: AppStore; view: EditorView | null; t: Translate; open: boolean }

export function SearchPanel({ store, view, t, open }: Props): JSX.Element {
  const [text, setText] = useState(store.state.settings.searchQuery);
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(store.state.settings.searchCase);
  const [regexp, setRegexp] = useState(store.state.settings.searchRegex);
  const [wholeWord, setWholeWord] = useState(store.state.settings.searchWord);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [, force] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const version = useRef(0), busyRef = useRef(false), mounted = useRef(true);
  const statusId = useId();
  const activeId = store.active?.id;
  const query = useMemo<SearchQuery | null>(() => text ? { text, caseSensitive, regexp, wholeWord } : null,
    [text, caseSensitive, regexp, wholeWord]);
  const valid = !query || validSearchQuery(query);
  const latest = useRef({ view, activeId, open, query, replacement });
  latest.current = { view, activeId, open, query, replacement };

  const cancelTimer = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; version.current++; cancelTimer(); };
  }, []);
  useEffect(() => view ? subscribeSearch(view, () => { if (mounted.current) force((value) => value + 1); }) : undefined, [view]);

  const failureMessage = (code: SearchFailure) => code === "timeout" ? t.searchTimeout :
    code === "unavailable" ? t.searchWorkerUnavailable : code === "too-large" ? t.searchTooLarge :
    code === "cancelled" ? t.searchTargetChanged : t.searchReplaceFailed;

  // Opening, closing and switching tabs invalidate every deferred operation.
  // The same EditorView is reused by the store for different tabs.
  useEffect(() => {
    const revision = ++version.current;
    cancelTimer();
    setError("");
    if (!view) return;
    if (!open || !query || !valid) {
      if (searchStateOf(view.state).query) view.dispatch({ effects: setSearchState.of({ query: null }) });
      force((value) => value + 1);
      return;
    }
    if (sameSearch(searchStateOf(view.state).query, query)) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (version.current !== revision || !mounted.current || store.view !== view || store.active?.id !== activeId ||
          !latest.current.open || !sameSearch(latest.current.query, query)) return;
      view.dispatch({ effects: setSearchState.of({ query }) });
      gotoMatch(view, 0);
      force((value) => value + 1);
    }, 120);
    return cancelTimer;
  }, [query, valid, open, view, activeId, store]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.inert = !open;
    if (open) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [open, activeId]);

  /** Apply the current draft now; cancelling a timer alone would lose Enter's query. */
  const syncQuery = (): boolean | null => {
    cancelTimer();
    if (!view || store.view !== view || store.active?.id !== activeId) return null;
    const desired = valid ? query : null;
    const state = searchStateOf(view.state);
    const changed = !sameSearch(state.query, desired) || !!state.error;
    if (changed) view.dispatch({ effects: setSearchState.of({ query: desired, refresh: !!state.error }) });
    return changed;
  };
  const navigate = (forward: boolean) => {
    if (!view || !query || !valid || busyRef.current) return;
    const changed = syncQuery();
    if (changed === null) return;
    if (changed) gotoMatch(view, forward ? 0 : -1);
    else findNext(view, forward);
    force((value) => value + 1);
  };
  const close = () => {
    version.current++;
    cancelTimer();
    if (view && store.view === view && store.active?.id === activeId) view.dispatch({ effects: setSearchState.of({ query: null }) });
    store.setSearchOpen(false);
    store.view?.focus();
  };
  const replaceOne = async () => {
    if (!view || !query || !valid || busyRef.current || view.state.readOnly) return;
    const changed = syncQuery();
    if (changed === null) return;
    if (changed) gotoMatch(view, 0);
    const selection = view.state.selection.main;
    const selected = searchStateOf(view.state).matches.some((match) => match.from === selection.from && match.to === selection.to);
    const revision = version.current;
    const current = () => mounted.current && latest.current.open && version.current === revision &&
      store.view === view && store.active?.id === activeId && latest.current.replacement === replacement && sameSearch(latest.current.query, query);
    busyRef.current = true; setBusy(true); setError("");
    try {
      if (!await replaceCurrent(view, { ...query, replacement }, current) && selected && current()) setError(t.searchReplaceFailed);
    } catch (failure) {
      if (mounted.current && latest.current.open) setError(failure instanceof SearchWorkError ? failureMessage(failure.code) : t.searchReplaceFailed);
    } finally {
      busyRef.current = false;
      if (mounted.current) { setBusy(false); force((value) => value + 1); }
    }
  };
  const replaceEvery = async () => {
    if (!view || !query || !valid || busyRef.current || view.state.readOnly) return;
    if (syncQuery() === null) return;
    const revision = version.current;
    const current = () => {
      const now = latest.current;
      return mounted.current && revision === version.current && now.open && now.view === view && store.view === view &&
        store.active?.id === activeId && now.activeId === activeId && now.replacement === replacement &&
        sameSearch(now.query, query) && !view.state.readOnly;
    };
    busyRef.current = true; setBusy(true); setError("");
    try {
      const plan = await prepareReplaceAll(view, { ...query, replacement });
      if (!plan || !current() || view.state.doc !== plan.doc) {
        if (mounted.current && latest.current.open) setError(t.searchTargetChanged);
        return;
      }
      const accepted = await askDialog(t.f.replaceAllConfirm(plan.count));
      if (!accepted || !mounted.current) return;
      if (!current() || view.state.doc !== plan.doc) {
        if (latest.current.open) setError(t.searchTargetChanged);
        return;
      }
      const count = applyReplaceAll(view, plan);
      if (count) store.toast(t.f.replaced(count));
      else setError(t.searchReplaceFailed);
      force((value) => value + 1);
    } catch (failure) {
      if (mounted.current && latest.current.open) setError(failure instanceof SearchWorkError ? failureMessage(failure.code) : t.searchReplaceFailed);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const state = view ? searchStateOf(view.state) : null;
  const pending = !!query && valid && (!sameSearch(state?.query ?? null, query) || !!state?.pending);
  const count = !pending && valid && !state?.error ? state?.total ?? state?.matches.length ?? 0 : 0;
  const unknownTotal = !!state?.limited && state.total === null;
  const position = state && state.current >= 0 ? state.offset + state.current + 1 : 0;
  const canReplace = !!view && !view.state.readOnly && !!query && valid && count > 0 && !busy;
  const status = !text ? "" : !valid ? t.searchRegexError : pending ? t.searchSearching : state?.error ? t.searchStopped :
    count ? (unknownTotal ? t.f.findCountLimited : t.f.findCount)(position, count) : t.findNone;
  const issue = error || (state?.error ? failureMessage(state.error) : "");

  return (
    <div className={"searchbar" + (open ? " is-open" : "")} aria-hidden={!open} aria-busy={busy}>
      <div ref={bodyRef} className="searchbar-fixed">
        <div className="searchbar-row">
          <input ref={inputRef} className="search-input" placeholder={t.findPlaceholder} aria-label={t.findPlaceholder}
            aria-invalid={!valid} aria-describedby={statusId} value={text} disabled={busy}
            onChange={(event) => { setText(event.target.value); store.persistSettings({ searchQuery: event.target.value }); }}
            onKeyDown={(event) => {
              if (imeComposing(event)) return;
              if (event.key === "Enter") { event.preventDefault(); navigate(!event.shiftKey); }
              else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
            }} />
          <span id={statusId} role="status" aria-live="polite" className={"search-count" + (!count && text ? " is-none" : "")}
            title={state?.limited ? t.searchLimited : undefined}>{status}</span>
          <button className={"search-toggle" + (caseSensitive ? " is-on" : "")} aria-pressed={caseSensitive}
            aria-label={t.findCaseSensitive} title={t.findCaseSensitive} disabled={busy}
            onClick={() => { setCaseSensitive(!caseSensitive); store.persistSettings({ searchCase: !caseSensitive }); }}>Aa</button>
          <button className={"search-toggle" + (wholeWord ? " is-on" : "")} aria-pressed={wholeWord}
            aria-label={t.findWholeWord} title={t.findWholeWord} disabled={busy}
            onClick={() => { setWholeWord(!wholeWord); store.persistSettings({ searchWord: !wholeWord }); }}>[w]</button>
          <button className={"search-toggle" + (regexp ? " is-on" : "")} aria-pressed={regexp}
            aria-label={t.findRegex} title={t.findRegex} disabled={busy}
            onClick={() => { setRegexp(!regexp); store.persistSettings({ searchRegex: !regexp }); }}>.*</button>
          <button className="search-toggle" aria-label={t.findPrev} title={t.findPrev} disabled={busy || !query || !valid || !view}
            onClick={() => navigate(false)}>↑</button>
          <button className="search-toggle" aria-label={t.findNext} title={t.findNext} disabled={busy || !query || !valid || !view}
            onClick={() => navigate(true)}>↓</button>
          <button className="search-toggle" aria-label={t.replacePlaceholder} title={t.replacePlaceholder}
            aria-expanded={replaceOpen} onClick={() => setReplaceOpen(!replaceOpen)}>⇄</button>
          <button className="search-toggle" aria-label={t.close} title={t.close} onClick={close}>✕</button>
        </div>
        {replaceOpen && <div className="searchbar-row">
          <input className="search-input" placeholder={t.replacePlaceholder} aria-label={t.replacePlaceholder}
            value={replacement} disabled={busy} onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (imeComposing(event)) return;
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
              else if (event.key === "Enter") { event.preventDefault(); void replaceOne(); }
            }} />
          <button className="search-toggle" disabled={!canReplace} onClick={() => { void replaceOne(); }}>{t.findReplaceOne}</button>
          <button className="search-toggle" disabled={!canReplace}
            title={view?.state.readOnly ? t.lockedNoEdit : t.findReplaceAll}
            onClick={() => { void replaceEvery(); }}>{t.findReplaceAll}{count ? " (" + count + (unknownTotal ? "+" : "") + ")" : ""}</button>
        </div>}
        {issue && <div className="search-action-error" role="alert">{issue}</div>}
      </div>
    </div>
  );
}
