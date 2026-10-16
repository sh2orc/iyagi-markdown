// 특수 문자 삽입(Word "기호" 대화상자) — 분류 탭 + 검색 + 클릭 삽입.
// 연속 삽입: 패널은 닫히지 않고 커서에 계속 넣는다(Word과 같은 워크플로).
// 키보드: 검색창이 포커스를 유지하고 ↑↓←→로 셀 선택, Enter 삽입(명령 팔레트
// 키크롤과 같은 규약 — 마우스 없이 기호 삽입이 끝나야 한다).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { SYMBOL_CATS, searchSymbols, type SymbolCat } from "../app/symbols";
import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";

interface Props {
  t: Translate;
  onInsert: (ch: string) => void;
  onClose: () => void;
}

export function SymbolPanel({ t, onInsert, onClose }: Props): JSX.Element {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<SymbolCat | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cellEls = useRef<(HTMLButtonElement | null)[]>([]);
  // 그리드 열 수(auto-fill이라 CSS가 정함) — 첫 행의 offsetTop이 같은 셀 수로 측정.
  const colsRef = useRef(8);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const list = useMemo(() => searchSymbols(query, cat ?? undefined), [query, cat]);

  // 검색·분류가 바뀌면 선택을 처음으로.
  useEffect(() => {
    setSel(0);
  }, [query, cat]);

  useLayoutEffect(() => {
    const g = gridRef.current;
    if (!g) return;
    let cols = 0;
    while (cols < g.children.length && (g.children[cols] as HTMLElement).offsetTop === (g.children[0] as HTMLElement).offsetTop) cols++;
    if (cols > 0) colsRef.current = cols;
  }, [list]);

  // 선택 셀이 그리드 스크롤을 벗어나면 따라온다.
  useEffect(() => {
    cellEls.current[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const move = (d: number) => setSel((s) => Math.max(0, Math.min(s + d, list.length - 1)));

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
          role="combobox"
          aria-expanded={list.length > 0}
          aria-controls="symbol-listbox"
          aria-activedescendant={list[sel] ? `symbol-opt-${sel}` : undefined}
          placeholder={t.symbolSearch}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (imeComposing(e)) return; // IME 조합 중 키는 IME가 소비(한글 Esc·Enter 새기기 방지)
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              move(colsRef.current);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-colsRef.current);
            } else if (e.key === "Home") {
              e.preventDefault();
              setSel(0);
            } else if (e.key === "End") {
              e.preventDefault();
              setSel(Math.max(0, list.length - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const s = list[sel];
              if (s) onInsert(s.ch);
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
        <div className="symbol-grid" ref={gridRef} role="listbox" id="symbol-listbox" aria-label={t.symbolSearch}>
          {list.map((s, i) => (
            <button
              key={`${s.ch}-${s.name}`}
              id={`symbol-opt-${i}`}
              role="option"
              aria-selected={i === sel}
              ref={(el) => {
                cellEls.current[i] = el;
              }}
              className="symbol-cell"
              title={s.name}
              style={i === sel ? { background: "var(--md-accent-soft)", outline: "2px solid var(--md-accent)" } : undefined}
              onClick={() => {
                setSel(i);
                onInsert(s.ch);
              }}
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
