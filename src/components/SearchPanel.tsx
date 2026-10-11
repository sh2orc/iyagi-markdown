// 문서 내 검색 패널(M09): 찾기·바꾸기, 대소문자·정규식, 매치 수·이동.

import { useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import {
  computeMatches,
  findNext,
  gotoMatch,
  replaceAll,
  replaceCurrent,
  searchStateOf,
  setSearchState,
  type SearchQuery,
} from "../search/searchCm";

interface Props {
  store: AppStore;
  view: EditorView;
  t: Translate;
}

export function SearchPanel({ store, view, t }: Props): JSX.Element {
  const [text, setText] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [, force] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [, closeSignal] = useState(0);
  void closeSignal;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const query: SearchQuery | null = text ? { text, caseSensitive, regexp, replacement } : null;

  const apply = (q: SearchQuery | null) => {
    view.dispatch({ effects: setSearchState.of({ query: q }) });
    if (q) {
      const matches = computeMatches(view.state.doc.toString(), q);
      if (matches.length > 0) gotoMatch(view, 0);
    }
    force((n) => n + 1);
  };

  const st = searchStateOf(view.state);
  const count = st.matches.length;
  const current = st.current + 1;

  const close = () => {
    view.dispatch({ effects: setSearchState.of({ query: null }) });
    store.setSearchOpen(false);
    view.focus();
  };

  return (
    <div className="searchbar">
      <div className="searchbar-row">
        <input
          ref={inputRef}
          className="search-input"
          placeholder={t.findPlaceholder}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            apply(e.target.value ? query : null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              findNext(view, !e.shiftKey);
              force((n) => n + 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        />
        <span className={`search-count ${count === 0 && text ? "is-none" : ""}`}>
          {text ? (count > 0 ? t.f.findCount(current, count) : t.findNone) : ""}
        </span>
        <button
          className={`search-toggle ${caseSensitive ? "is-on" : ""}`}
          title={t.findCaseSensitive}
          onClick={() => {
            setCaseSensitive(!caseSensitive);
            apply(query ? { ...query, caseSensitive: !caseSensitive } : null);
          }}
        >
          Aa
        </button>
        <button
          className={`search-toggle ${regexp ? "is-on" : ""}`}
          title={t.findRegex}
          onClick={() => {
            setRegexp(!regexp);
            apply(query ? { ...query, regexp: !regexp } : null);
          }}
        >
          .*
        </button>
        <button
          className="search-toggle"
          title={t.findPlaceholder}
          onClick={() => {
            if (!text) return;
            findNext(view, false);
            force((n) => n + 1);
          }}
        >
          ↑
        </button>
        <button
          className="search-toggle"
          title={t.findPlaceholder}
          onClick={() => {
            if (!text) return;
            findNext(view, true);
            force((n) => n + 1);
          }}
        >
          ↓
        </button>
        <button className="search-toggle" title={t.replacePlaceholder} onClick={() => setReplaceOpen(!replaceOpen)}>
          ⇄
        </button>
        <button className="search-toggle" title={t.close} onClick={close}>
          ✕
        </button>
      </div>
      {replaceOpen && (
        <div className="searchbar-row">
          <input
            className="search-input"
            placeholder={t.replacePlaceholder}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          />
          <button
            className="search-toggle"
            disabled={!query || count === 0}
            onClick={() => {
              if (!query) return;
              replaceCurrent(view, { ...query, replacement });
              force((n) => n + 1);
            }}
          >
            {t.findReplaceOne}
          </button>
          <button
            className="search-toggle"
            disabled={!query || count === 0}
            onClick={() => {
              if (!query) return;
              const n = replaceAll(view, { ...query, replacement });
              store.toast(t.f.replaced(n));
              force((x) => x + 1);
            }}
          >
            {t.findReplaceAll}
          </button>
        </div>
      )}
    </div>
  );
}
