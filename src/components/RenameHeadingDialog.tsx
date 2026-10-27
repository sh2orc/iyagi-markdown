// 제목 이름 바꾸기 대화상자 — 커서가 있는 제목의 텍스트를 고치고
// [[문서#앵커]] 링크를 함께 갱신한다(Word의 "이 머리글에 대한 모든 링크 업데이트").

import { useEffect, useRef, useState } from "react";

import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";

interface Props {
  initialTitle: string;
  linkCount: number;
  t: Translate;
  onConfirm: (next: { title: string; updateLinks: boolean }) => void | Promise<void>;
  onCancel: () => void;
}

export function RenameHeadingDialog({ initialTitle, linkCount, t, onConfirm, onCancel }: Props): JSX.Element {
  const [title, setTitle] = useState(initialTitle);
  const [original] = useState(initialTitle);
  const [updateLinks, setUpdateLinks] = useState(linkCount > 0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const cancel = () => {
    if (busyRef.current) return;
    onCancel();
  };
  const ok = async () => {
    const next = title.trim();
    if (busyRef.current || !next || next === original) { if (!next) setError(t.renameHeadingEmpty); return; }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ title: next, updateLinks });
    } catch (cause) {
      setError(String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t.renameHeadingTitle}
      onClick={(e) => e.target === e.currentTarget && cancel()}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !imeComposing(e) && !busyRef.current) {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      }}
    >
      <div className="modal link-dialog">
        <div className="modal-title">{t.renameHeadingTitle}</div>
        <label className="settings-label">
          {t.renameHeadingLabel}
          <input
            ref={inputRef}
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !imeComposing(e)) {
                e.preventDefault();
                void ok();
              }
            }}
          />
        </label>
        {linkCount > 0 && (
          <label className="settings-label">
            <input
              type="checkbox"
              checked={updateLinks}
              disabled={busy}
              onChange={(e) => setUpdateLinks(e.target.checked)}
            />
            {t.f.renameHeadingLinks(linkCount)}
          </label>
        )}
        {error && <p className="comment-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-plain" onClick={cancel} disabled={busy}>{t.cancel}</button>
          <button className="btn btn-primary" onClick={() => void ok()} disabled={busy || !title.trim() || title.trim() === original}>
            {t.done}
          </button>
        </div>
      </div>
    </div>
  );
}
