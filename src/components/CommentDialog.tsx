// 성공 응답까지 입력을 보존한다. 실패·충돌 시 같은 텍스트로 다시 편집할 수 있다.
import { useEffect, useId, useRef, useState } from "react";
import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";

interface Props {
  t: Translate;
  lineNo: number;
  title?: string;
  initial?: string;
  onConfirm: (text: string) => Promise<void>;
  onCancel: () => void;
}

export function CommentDialog({ t, lineNo, title, initial = "", onConfirm, onCancel }: Props): JSX.Element {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    alive.current = true;
    ref.current?.focus();
    return () => { alive.current = false; };
  }, []);

  const cancel = () => {
    if (busyRef.current) return;
    if (text !== initial) setDiscard(true);
    else onCancel();
  };
  const save = async () => {
    if (busyRef.current || !text.trim()) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setDiscard(false);
    try { await onConfirm(text); }
    catch (cause) { if (alive.current) setError(String(cause)); }
    finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className="overlay modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}
      onKeyDown={(e) => {
        if (imeComposing(e)) return;
        if (e.key === "Escape") {
          e.preventDefault(); e.stopPropagation();
          if (discard) setDiscard(false); else cancel();
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault(); e.stopPropagation(); void save();
        }
      }}>
      <div className="modal comment-dialog" aria-busy={busy}>
        <div className="modal-title" id={titleId}>
          {t.commentTitle} <span className="modal-file-name">{title ? `${title} · ` : ""}{t.ln} {lineNo}</span>
        </div>
        <textarea ref={ref} className="comment-textarea" rows={4} value={text} readOnly={busy}
          maxLength={20_000} aria-label={t.commentTitle} placeholder={t.commentPlaceholder}
          onChange={(e) => setText(e.target.value)} />
        {error && <div className="comment-error" role="alert">{t.commentSaveFailed}: {error}</div>}
        {discard ? (
          <div className="comment-error" role="alert">
            <p>{t.commentDiscardPrompt}</p>
            <button className="btn" onClick={() => { setDiscard(false); ref.current?.focus(); }}>{t.commentKeepEditing}</button>
            <button className="btn btn-plain" onClick={onCancel}>{t.commentDiscard}</button>
          </div>
        ) : (
          <div className="modal-actions">
            <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void save()}>
              {busy ? t.commentSaving : t.save}
            </button>
            <button className="btn btn-plain" disabled={busy} onClick={cancel}>{t.cancel}</button>
          </div>
        )}
      </div>
    </div>
  );
}
