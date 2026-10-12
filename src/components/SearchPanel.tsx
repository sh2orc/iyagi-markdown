// 문서 내 검색 패널(M09): 찾기·바꾸기, 대소문자·정규식, 매치 수·이동.
// 항상 마운트된 채 슬라이드로 열고 닫는다 — 검색어·옵션이 세션 내 보존되고
// 열림이 툭 튀지 않는다.

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
  view: EditorView | null;
  t: Translate;
  open: boolean;
}

export function SearchPanel({ store, view, t, open }: Props): JSX.Element | null {
  const [text, setText] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [, force] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [, closeSignal] = useState(0);
  void closeSignal;

  const query: SearchQuery | null = text ? { text, caseSensitive, regexp, wholeWord, replacement } : null;

  // 검색 적용 — 상태 필드가 매치를 계산하므로 여기서 다시 훑지 않는다(중복
  // O(문서) 스캔 제거). 입력은 짧게 디바운스해 큰 문서에서 타이핑이 끊기지
  // 않게 한다.
  const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (applyTimer.current) clearTimeout(applyTimer.current);
  }, []);

  const apply = (q: SearchQuery | null) => {
    if (!view) return;
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

  const st = view ? searchStateOf(view.state) : { query: null, matches: [], current: -1 };
  const count = st.matches.length;
  const current = st.current + 1;

  // 열림 — 포커스·선택. 검색어를 유지 중이면 매치도 다시 살린다(닫힘 때
  // 하이라이트는 지웠으므로). 닫힘 — 입력으로 포커스가 새지 않게 inert.
  useEffect(() => {
    if (!view) return;
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
      if (text) apply(query);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, view]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.inert = !open;
  }, [open]);

  const close = () => {
    if (!view) return;
    if (applyTimer.current) {
      clearTimeout(applyTimer.current);
      applyTimer.current = null;
    }
    view.dispatch({ effects: setSearchState.of({ query: null }) });
    store.setSearchOpen(false);
    view.focus();
  };

  return (
    <div className={`searchbar ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <div ref={bodyRef} className="searchbar-fixed">
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
            if (v) applyDebounced({ text: v, caseSensitive, regexp, wholeWord, replacement });
            else apply(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              // 보류 중이던 쿼리를 방금 확정했다면 첫 매치 이동이 이미 일어났다.
              if (flush() || !view) return;
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
          className={`search-toggle ${wholeWord ? "is-on" : ""}`}
          title={t.findWholeWord}
          onClick={() => {
            setWholeWord(!wholeWord);
            apply(query ? { ...query, wholeWord: !wholeWord } : null);
          }}
        >
          [w]
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
            if (!text || !view) return;
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
            if (!text || !view) return;
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
              if (!query || !view) return;
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
              if (!query || !view) return;
              // 실행 전 확인(Word의 바꾸기 확인) — 취소하면 원문 그대로.
              const ok = window.confirm(t.f.replaceAllConfirm(count));
              if (!ok) return;
              const n = replaceAll(view, { ...query, replacement });
              store.toast(t.f.replaced(n));
              force((x) => x + 1);
            }}
            title={`${t.findReplaceAll} (${count})`}
          >
            {t.findReplaceAll}{count > 0 ? ` (${count})` : ""}
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
