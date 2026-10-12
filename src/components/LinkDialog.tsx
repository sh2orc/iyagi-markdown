// 링크 편집 대화상자(Word 하이퍼링크 편집) — 표시 텍스트·URL을 고쳐
// 원문의 [텍스트](url) 범위를 교체한다. 삽입(빈 값)에도 같은 대화상자.

import { useEffect, useRef, useState } from "react";

import type { Translate } from "../i18n";

export interface LinkEditTarget {
  text: string;
  url: string;
  from: number;
  to: number;
}

interface Props {
  initial: LinkEditTarget;
  t: Translate;
  onConfirm: (next: { text: string; url: string }) => void;
  onCancel: () => void;
}

export function LinkDialog({ initial, t, onConfirm, onCancel }: Props): JSX.Element {
  const [text, setText] = useState(initial.text);
  const [url, setUrl] = useState(initial.url);
  const urlRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    (initial.text ? urlRef.current : document.querySelector<HTMLInputElement>(".link-dialog input"))?.focus();
    // 마운트 시 1회 포커스 — initial.text가 없으면 첫 필드(텍스트)로.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ok = () => {
    if (!url.trim()) return;
    onConfirm({ text: text.trim() || url.trim(), url: url.trim() });
  };

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="modal link-dialog">
        <div className="modal-title">{t.linkEditTitle}</div>
        <label className="settings-label">
          {t.linkEditText}
          <input value={text} onChange={(e) => setText(e.target.value)} autoFocus={!initial.text} />
        </label>
        <label className="settings-label">
          {t.linkEditUrl}
          <input
            ref={urlRef}
            value={url}
            placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                ok();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onCancel();
              }
            }}
          />
        </label>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={ok} disabled={!url.trim()}>
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
