// 표 삽입 대화상자(Word 표 삽입) — 행·열 수를 물어 표 골격을 넣는다.
// 표 미리보기 그리드(Word의 셀 호버 선택)를 간소화한 스핀 형태.

import { useEffect, useRef, useState } from "react";

import { insertTable } from "../editor/format";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
}

const MIN = 1;
const MAX = 20;

export function TableDialog({ store, t, onClose }: Props): JSX.Element {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const rowsRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    rowsRef.current?.focus();
    rowsRef.current?.select();
  }, []);

  const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, Math.round(n) || MIN));

  const insert = () => {
    const view = store.view;
    onClose();
    if (view) insertTable(view, clamp(rows), clamp(cols));
    view?.focus();
  };

  const num = (
    label: string,
    value: number,
    set: (n: number) => void,
    ref?: React.Ref<HTMLInputElement>,
  ) => (
    <label className="settings-label">
      {label}
      <input
        ref={ref}
        type="number"
        min={MIN}
        max={MAX}
        value={value}
        onChange={(e) => set(clamp(Number(e.target.value)))}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            insert();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
    </label>
  );

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal table-dialog">
        <div className="modal-title">{t.tableInsertTitle}</div>
        <div className="table-dialog-fields">
          {num(t.tableRows, rows, setRows, rowsRef)}
          {num(t.tableCols, cols, setCols)}
        </div>
        {/* 미리보기 — 골격 모양을 눈으로 확인(최대 6×6 표시). */}
        <div className="table-dialog-preview" aria-hidden="true">
          {Array.from({ length: Math.min(rows, 6) }, (_, r) => (
            <div key={r} className={r === 0 ? "trow head" : "trow"}>
              {Array.from({ length: Math.min(cols, 6) }, (_, c) => (
                <span key={c} className="tcell" />
              ))}
            </div>
          ))}
          {(rows > 6 || cols > 6) && <div className="table-dialog-more">…</div>}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={insert}>
            {t.insert}
          </button>
          <button className="btn btn-plain" onClick={onClose}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
