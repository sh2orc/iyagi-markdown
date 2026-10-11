// 문서 내 검색 패널(M09): 찾기·바꾸기, 대소문자·정규식, 매치 수·이동.

import { useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";

import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import {
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

  // 검색 적용 — 상태 필드가 매치를 계산하므로 여기서 다시 훑지 않는다(중복
  // O(문서) 스캔 제거). 입력은 짧게 디바운스해 큰 문서에서 타이핑이 끊기지
  // 않게 한다.
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (applyTimer.current) clearTimeout(applyTimer.current);
  }, []);

  const apply = (q: SearchQuery | null) => {
    view.dispatch({ effects: setSearchState.of({ query: q }) });
    if (q && searchStateOf(view.state).matches.length > 0) gotoMatch(view, 0);
    force((n) => n + 1);
  };
  const applyDebounced = (q: SearchQuery) => {
    if (applyTimer.current) clearTimeout(applyTimer.current);
    applyTimer.current = setTimeout(() => {
      applyTimer.current = null;
      apply(q);
    }, 120);
  };
  /** 보류 중인 디바운스를 즉시 확정(Enter 등). */
  const flush = () => {
    if (applyTimer.current) {
      clearTimeout(applyTimer.current);
      applyTimer.current = null;
      return true;
    }
    return false;
  };

  const st = searchStateOf(view.state);
  const count = st.matches.length;
  const current = st.current + 1;

  const close = () => {
    if (applyTimer.current) {
      clearTimeout(applyTimer.current);
      applyTimer.current = null;
    }
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
            const v = e.target.value;
            setText(v);
            // 주의: 렌더 시점의 query는 한 글자 뒤처진 값이다 — 여기서 새로 만든다.
            if (v) applyDebounced({ text: v, caseSensitive, regexp, replacement });
            else apply(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // 보류 중이던 쿼리를 방금 확정했다면 첫 매치 이동이 이미 일어났다.
              if (flush()) return;
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
