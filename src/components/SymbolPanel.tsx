// 특수 문자 삽입(Word "기호" 대화상자) — 분류 탭 + 검색 + 클릭 삽입.
// 연속 삽입: 패널은 닫히지 않고 커서에 계속 넣는다(Word과 같은 워크플로).

import { useEffect, useMemo, useRef, useState } from "react";

import { SYMBOL_CATS, searchSymbols, type SymbolCat } from "../app/symbols";
import type { Translate } from "../i18n";

interface Props {
  t: Translate;
  onInsert: (ch: string) => void;
  onClose: () => void;
}

export function SymbolPanel({ t, onInsert, onClose }: Props): JSX.Element {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<SymbolCat | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const list = useMemo(() => searchSymbols(query, cat ?? undefined), [query, cat]);

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal symbol-modal">
        <div className="modal-title">{t.symbolTitle}</div>
        <input
          ref={inputRef}
          className="palette-input symbol-search"
          placeholder={t.symbolSearch}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="symbol-cats">
          <button
            className={`symbol-cat ${cat === null ? "is-sel" : ""}`}
            onClick={() => setCat(null)}
          >
            {t.symbolAll}
          </button>
          {SYMBOL_CATS.map((c) => (
            <button
              key={c.id}
              className={`symbol-cat ${cat === c.id ? "is-sel" : ""}`}
              onClick={() => setCat(c.id)}
            >
              {t[c.labelKey]}
            </button>
          ))}
        </div>
        <div className="symbol-grid">
          {list.map((s) => (
            <button
              key={`${s.ch}-${s.name}`}
              className="symbol-cell"
              title={s.name}
              onClick={() => onInsert(s.ch)}
            >
              {s.ch}
            </button>
          ))}
          {list.length === 0 && <div className="palette-empty">{t.symbolNoMatch}</div>}
        </div>
        <div className="modal-actions">
          <button className="btn btn-plain" onClick={onClose}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}
