// 표 삽입 대화상자(Word 표 삽입) — 행·열 수를 물어 표 골격을 넣는다.
// 표 미리보기 그리드(Word의 셀 호버 선택)를 간소화한 스핀 형태.

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { blockInsertionText, tableMarkdown } from "../editor/format";
import { captureAsyncEdit } from "../editor/asyncEdit";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
}

const MIN = 1;
const MAX = 20;
const dimension = (value: string): number | null => {
  const n = Number(value);
  return /^\d+$/.test(value) && Number.isInteger(n) && n >= MIN && n <= MAX ? n : null;
};

export function TableDialog({ store, t, onClose }: Props): JSX.Element {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [rows, setRows] = useState("3");
  const [cols, setCols] = useState("3");
  const [origin] = useState(() => {
    const view = store.view;
    return { view, tabId: store.active?.id, selection: view?.state.selection.main, doc: view?.state.doc };
  });
  const pending = useRef<ReturnType<typeof captureAsyncEdit>>(null);
  const submitted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const rowsRef = useRef<HTMLInputElement | null>(null);
  const hintId = useId();
  const rowCount = dimension(rows), colCount = dimension(cols);
  const isOriginCurrent = () => !!origin.view && !!origin.tabId && store.view === origin.view &&
    store.active?.id === origin.tabId && !origin.view.state.readOnly;
  const targetChanged = !isOriginCurrent();

  useEffect(() => {
    const target = origin.view && origin.tabId && origin.selection && store.view === origin.view &&
      store.active?.id === origin.tabId && origin.view.state.doc === origin.doc
      ? captureAsyncEdit(origin.view, "table-dialog", origin.selection) : null;
    pending.current = target;
    rowsRef.current?.focus();
    rowsRef.current?.select();
    return () => { target?.finish(); };
  }, [origin, store]);

  const close = () => { pending.current?.finish(); onClose(); };
  const cancel = () => {
    if (rows !== "3" || cols !== "3") setDiscard(true);
    else close();
  };

  const insert = () => {
    if (submitted.current || discard) return;
    if (rowCount === null || colCount === null) { setError(t.tableSizeHint); return; }
    if (!isOriginCurrent() || !pending.current?.current()) { setError(t.tableTargetChanged); return; }
    submitted.current = true;
    try {
      const text = blockInsertionText(tableMarkdown(rowCount, colCount, t.tableColumnHeading));
      if (!pending.current.replace(text, "input.insertTable")) {
        setError(t.tableInsertFailed); submitted.current = false; return;
      }
      close();
    } catch {
      setError(t.tableInsertFailed); submitted.current = false;
    }
  };

  const num = (
    label: string,
    value: string,
    set: (n: string) => void,
    ref?: React.Ref<HTMLInputElement>,
  ) => (
    <label className="settings-label">
      {label}
      <input
        ref={ref}
        type="number"
        min={MIN}
        max={MAX}
        step={1}
        value={value}
        aria-describedby={hintId}
        aria-invalid={dimension(value) === null}
        onChange={(e) => { set(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          if (imeComposing(e)) return; // IME 조합 중 키는 IME가 소비(한글 Esc·Enter 새기기 방지)
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            insert();
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
      aria-label={t.tableInsertTitle}
      onClick={(e) => e.target === e.currentTarget && cancel()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !imeComposing(e)) {
          e.preventDefault(); e.stopPropagation();
          if (discard) setDiscard(false); else cancel();
        }
      }}
    >
      <div className="modal table-dialog">
        <div className="modal-title">{t.tableInsertTitle}</div>
        <div className="table-dialog-fields">
          {num(t.tableRows, rows, setRows, rowsRef)}
          {num(t.tableCols, cols, setCols)}
        </div>
        <p id={hintId}>{t.tableSizeHint}</p>
        {/* 본문 행 + 헤더 1행. 최대 6×6만 표시한다. */}
        {rowCount !== null && colCount !== null && <div className="table-dialog-preview" aria-hidden="true">
          {Array.from({ length: Math.min(rowCount + 1, 6) }, (_, r) => (
            <div key={r} className={r === 0 ? "trow head" : "trow"}>
              {Array.from({ length: Math.min(colCount, 6) }, (_, c) => (
                <span key={c} className="tcell" />
              ))}
            </div>
          ))}
          {(rowCount + 1 > 6 || colCount > 6) && <div className="table-dialog-more">…</div>}
        </div>}
        {(targetChanged || error) && <p className="comment-error" role="alert">{targetChanged ? t.tableTargetChanged : error}</p>}
        {discard ? <div className="comment-error" role="alert">
          <p>{t.tableDiscardPrompt}</p>
          <button className="btn" onClick={() => { setDiscard(false); rowsRef.current?.focus(); }}>{t.commentKeepEditing}</button>
          <button className="btn btn-plain" onClick={close}>{t.commentDiscard}</button>
        </div> : <div className="modal-actions">
          <button className="btn btn-primary" onClick={insert} disabled={targetChanged || rowCount === null || colCount === null}>
            {t.insert}
          </button>
          <button className="btn btn-plain" onClick={cancel}>
            {t.cancel}
          </button>
        </div>}
      </div>
    </div>
  );
}
