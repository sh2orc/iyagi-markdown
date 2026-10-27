import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import { dirname } from "../paths";
import { imeComposing } from "../app/ime";

/** Favorites stay available across workspaces and temporary file unavailability. */
export function FavoriteDocuments({ store, t, query = "", limit = 8 }: {
  store: AppStore; t: Translate; query?: string; limit?: number;
}): JSX.Element | null {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [expanded, setExpanded] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [moveNotice, setMoveNotice] = useState("");
  const ordering = organizing && !query.trim();
  const section = useRef<HTMLElement | null>(null);
  const openButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastFocus = useRef<{ path: string; index: number; element: HTMLElement } | null>(null);
  const wasBusy = useRef(false);
  const matches = useMemo(() => {
    const needle = query.trim().normalize("NFC").toLocaleLowerCase();
    return state.favorites.filter((path) => !needle || path.normalize("NFC").toLocaleLowerCase().includes(needle));
  }, [state.favorites, query]);
  const visible = matches.slice(0, expanded || ordering ? matches.length : limit);
  const visibleKey = visible.join("\0");
  useLayoutEffect(() => {
    const previous = lastFocus.current;
    const finished = wasBusy.current && !state.favoritesBusy;
    wasBusy.current = state.favoritesBusy;
    if (!previous) return;
    if (visible.includes(previous.path)) {
      previous.index = visible.indexOf(previous.path);
      if (finished && previous.element.isConnected && document.activeElement === document.body) previous.element.focus();
      return;
    }
    lastFocus.current = null;
    const active = document.activeElement;
    if (active !== previous.element && active !== document.body && active?.isConnected) return;
    (openButtons.current.get(visible[Math.min(previous.index, visible.length - 1)]) ?? section.current)?.focus();
  }, [visibleKey, state.favoritesBusy]);

  const move = async (path: string, direction: "up" | "down") => {
    if (!ordering) return;
    const before = document.activeElement;
    const ownedFocus = before instanceof HTMLElement && section.current?.contains(before);
    setMoveNotice("");
    if (!(await store.moveFavorite(path, direction)) || !section.current?.isConnected) return;
    const index = store.state.favorites.indexOf(path);
    if (index >= 0) setMoveNotice(`${t.favoriteMoved}: ${path.split("/").pop()} (${index + 1}/${store.state.favorites.length})`);
    // Keep the moved document reachable even when its arrow becomes disabled at
    // the list boundary. Late completion must not steal focus from another input.
    const active = document.activeElement;
    if (ownedFocus && (active === before || active === document.body || !active?.isConnected)) openButtons.current.get(path)?.focus();
  };

  if (!state.favoritesLoaded && !state.favoritesLoading && !state.favoritesError) return null;
  return <section ref={section} className="favorite-documents recent-documents" aria-label={t.favoritesTitle}
    tabIndex={-1} aria-busy={state.favoritesLoading || state.favoritesBusy}
    onFocusCapture={(event) => {
      const element = event.target as HTMLElement;
      const path = element.closest<HTMLElement>("[data-favorite-path]")?.dataset.favoritePath;
      if (path) lastFocus.current = { path, index: visible.indexOf(path), element };
    }} onBlurCapture={(event) => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) lastFocus.current = null;
    }}>
    <div className="recent-heading"><span className="sidebar-subtitle">★ {t.favoritesTitle}</span>
      {(state.favorites.length > 1 || organizing) && <button className="recent-action" aria-pressed={organizing}
        disabled={state.favoritesBusy || state.favoritesLoading || (!!query.trim() && !organizing)}
        title={query.trim() ? t.favoritesOrderFilter : t.favoritesOrder}
        onClick={(event) => { event.currentTarget.focus(); setOrganizing((value) => !value); setMoveNotice(""); }}>
        {organizing ? t.favoritesOrderDone : t.favoritesOrder}</button>}
    </div>
    {organizing && <p className="recent-status">{query.trim() ? t.favoritesOrderFilter : t.favoritesOrderHint}</p>}
    <p className="favorite-order-status" role="status" aria-live="polite">{moveNotice}</p>
    {state.favoritesLoading && <p className="recent-status" role="status">{t.favoritesLoading}</p>}
    {state.favoritesError && <div className="recent-status" role="alert">
      <p>{t.favoritesFailed}: {state.favoritesError}</p>
      <button className="recent-action" disabled={state.favoritesLoading || state.favoritesBusy}
        onClick={() => void store.loadFavorites()}>{t.wsRetry}</button>
    </div>}
    {state.favoritesLoaded && !state.favoritesError && matches.length === 0 &&
      <p className="recent-status">{query.trim() ? t.sidebarNoResults : t.favoritesEmpty}</p>}
    <ul className="recent-list">
      {visible.map((path, index) => {
        const name = path.split("/").pop() ?? path;
        return <li className="recent-row" key={path} data-favorite-path={path}
          onKeyDown={(event) => {
            if (!ordering || imeComposing(event) || event.repeat || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault(); event.stopPropagation();
            void move(path, event.key === "ArrowUp" ? "up" : "down");
          }}>
          <button ref={(button) => { if (button) openButtons.current.set(path, button); else openButtons.current.delete(path); }}
            className={`recent-open ${store.active?.path === path ? "is-active" : ""}`}
            aria-current={store.active?.path === path ? "page" : undefined} title={path}
            onClick={() => void store.openPath(path).catch((error) => store.toast(String(error), "error"))}>
            <span>{name}</span><span className="recent-path">{dirname(path)}</span>
          </button>
          {ordering && <span className="favorite-order-actions">
            <button className="recent-remove" disabled={state.favoritesBusy || state.favoritesLoading || index === 0}
              aria-label={`${t.favoriteMoveUp}: ${path}`} title={t.favoriteMoveUp}
              onClick={() => void move(path, "up")}>↑</button>
            <button className="recent-remove" disabled={state.favoritesBusy || state.favoritesLoading || index === visible.length - 1}
              aria-label={`${t.favoriteMoveDown}: ${path}`} title={t.favoriteMoveDown}
              onClick={() => void move(path, "down")}>↓</button>
          </span>}
          <button className="recent-remove" disabled={state.favoritesBusy || state.favoritesLoading}
            aria-label={`${t.favoriteRemove}: ${path}`} title={t.favoriteRemove}
            onClick={() => void store.setFavorite(path, false)}>×</button>
        </li>;
      })}
    </ul>
    {!ordering && matches.length > limit && <button className="recent-action recent-expand" aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}>{expanded ? t.recentShowLess : t.recentShowAll}</button>}
  </section>;
}
