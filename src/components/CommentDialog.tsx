// 메모 추가 대화상자(Word "메모") — 줄에 메모 텍스트를 단다.
// 저장은 사이드카(doc_comment) — 원문 불변(§4-2).

import { useEffect, useRef, useState } from "react";

import type { Translate } from "../i18n";

interface Props {
  t: Translate;
  lineNo: number;
  /** 수정 모드(기존 텍스트 프리필). */
  initial?: string;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

export function CommentDialog({ t, lineNo, initial = "", onConfirm, onCancel }: Props): JSX.Element {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="modal comment-dialog">
        <div className="modal-title">
          {t.commentTitle} <span className="modal-file-name">{t.ln} {lineNo}</span>
        </div>
        <textarea
          ref={ref}
          className="comment-textarea"
          rows={4}
          value={text}
          placeholder={t.commentPlaceholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (text.trim()) onConfirm(text);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        <div className="modal-actions">
          <button className="btn btn-primary" disabled={!text.trim()} onClick={() => onConfirm(text)}>
            {t.save}
          </button>
          <button className="btn btn-plain" onClick={onCancel}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
