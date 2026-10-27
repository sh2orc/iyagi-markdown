// 특수 문자 삽입(Word "기호" 대화상자) — 분류 탭 + 검색 + 클릭 삽입.
// 연속 삽입: 패널은 닫히지 않고 커서에 계속 넣는다(Word과 같은 워크플로).
// 검색창 포커스를 유지하며 ↑↓로 결과 선택, Enter 삽입. 좌우·Home·End는
// 검색어 편집에 사용한다. 연속 삽입 위치는 현재 에디터 커서와 별도로 추적한다.

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { SYMBOL_CATS, searchSymbols, type SymbolCat } from "../app/symbols";
import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";
import type { AppStore } from "../app/store";
import { captureAsyncEdit } from "../editor/asyncEdit";

interface Props {
  t: Translate;
  store: AppStore;
  onClose: () => void;
}

export function SymbolPanel({ t, store, onClose }: Props): JSX.Element {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<SymbolCat | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cellEls = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const hintId = useId();
  const [origin] = useState(() => {
    const view = store.view;
    return { view, tabId: store.active?.id, selection: view?.state.selection.main, doc: view?.state.doc };
  });
  const pending = useRef<ReturnType<typeof captureAsyncEdit>>(null);
  const inserting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [inserted, setInserted] = useState({ ch: "", count: 0 });
  const originCurrent = () => !!origin.view && !!origin.tabId && store.view === origin.view &&
    store.active?.id === origin.tabId && !origin.view.state.readOnly;
  const targetChanged = !originCurrent();

  useEffect(() => {
    const target = origin.view && origin.selection && origin.tabId && store.view === origin.view &&
      store.active?.id === origin.tabId && origin.view.state.doc === origin.doc
      ? captureAsyncEdit(origin.view, "symbol-panel", origin.selection) : null;
    pending.current = target;
    inputRef.current?.focus();
    return () => { target?.finish(); };
  }, [origin, store]);

  const list = useMemo(() => searchSymbols(query, cat ?? undefined), [query, cat]);

  const active = Math.max(0, Math.min(sel, list.length - 1));

  // 선택 셀이 그리드 스크롤을 벗어나면 따라온다.
  useEffect(() => {
    cellEls.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active, list]);

  const move = (d: number) => setSel((s) => Math.max(0, Math.min(s + d, list.length - 1)));
  const close = () => { pending.current?.finish(); onClose(); };
  const chooseCat = (next: SymbolCat | null) => { setCat(next); setSel(0); inputRef.current?.focus(); };
  const insert = (ch: string) => {
    if (inserting.current) return;
    if (!originCurrent() || !pending.current?.current()) { setError(t.symbolTargetChanged); return; }
    inserting.current = true;
    try {
      if (!pending.current.replace(ch, "input.symbol", { continueAtEnd: true })) {
        setError(t.symbolInsertFailed); return;
      }
      setError(null);
      setInserted((previous) => ({ ch, count: previous.count + 1 }));
    } catch { setError(t.symbolInsertFailed); }
    finally { inserting.current = false; inputRef.current?.focus(); }
  };

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t.symbolTitle}
      onClick={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !imeComposing(e)) {
          e.preventDefault(); e.stopPropagation(); close();
        }
      }}
    >
      <div className="modal symbol-modal">
        <div className="modal-title">{t.symbolTitle}</div>
        <input
          ref={inputRef}
          className="palette-input symbol-search"
          role="combobox"
          aria-label={t.symbolSearch}
          aria-autocomplete="list"
          aria-describedby={hintId}
          aria-expanded={list.length > 0}
          aria-controls={listId}
          aria-activedescendant={list[active] ? `${listId}-${active}` : undefined}
          placeholder={t.symbolSearch}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.defaultPrevented || imeComposing(e) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
            switch (e.key) {
              case "ArrowDown": move(1); break;
              case "ArrowUp": move(-1); break;
              case "PageDown": move(10); break;
              case "PageUp": move(-10); break;
              case "Enter": {
                const s = list[active];
                if (s && !e.repeat) insert(s.ch);
                break;
              }
              default: return;
            }
            e.preventDefault(); e.stopPropagation();
          }}
        />
        <div className="symbol-cats">
          <button
            className={`symbol-cat ${cat === null ? "is-sel" : ""}`}
            aria-pressed={cat === null}
            onClick={() => chooseCat(null)}
          >
            {t.symbolAll}
          </button>
          {SYMBOL_CATS.map((c) => (
            <button
              key={c.id}
              className={`symbol-cat ${cat === c.id ? "is-sel" : ""}`}
              aria-pressed={cat === c.id}
              onClick={() => chooseCat(c.id)}
            >
              {t[c.labelKey]}
            </button>
          ))}
        </div>
        <p id={hintId} className="symbol-help">{t.symbolKeyboardHint}</p>
        <div className="symbol-grid" role="listbox" id={listId} aria-label={t.symbolSearch}>
          {list.map((s, i) => (
            <button
              key={`${s.ch}-${s.name}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              aria-label={`${s.ch} ${s.name}`}
              tabIndex={-1}
              disabled={targetChanged}
              ref={(el) => {
                cellEls.current[i] = el;
              }}
              className="symbol-cell"
              title={s.name}
              style={i === active ? { background: "var(--md-accent-soft)", outline: "2px solid var(--md-accent)" } : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setSel(i);
                insert(s.ch);
              }}
            >
              {s.ch}
            </button>
          ))}
        </div>
        {list.length === 0 && <div className="palette-empty" role="status">{t.symbolNoMatch}</div>}
        {(targetChanged || error) && <p className="comment-error" role="alert">{targetChanged ? t.symbolTargetChanged : error}</p>}
        <div className="symbol-help" role="status" aria-atomic="true">
          {inserted.count > 0 && `${t.symbolInserted}: ${inserted.ch} (${inserted.count})`}
        </div>
        <div className="modal-actions">
          <button className="btn btn-plain" onClick={close}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}
