// 링크 편집 대화상자(Word 하이퍼링크 편집) — 표시 텍스트·URL을 고쳐
// 원문의 [텍스트](url) 범위를 교체한다. 삽입(빈 값)에도 같은 대화상자.

import { useEffect, useId, useRef, useState } from "react";

import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";

export interface LinkEditTarget {
  text: string;
  url: string;
  from: number;
  to: number;
}

interface Props {
  initial: LinkEditTarget;
  t: Translate;
  /** link = [텍스트](url), image = ![대체텍스트](src) — 라벨만 달라진다. */
  kind?: "link" | "image";
  /** URL 자동완성 후보(문서 폴더 상대 경로) — 없으면 datalist 생략. */
  pathHints?: string[];
  onConfirm: (next: { text: string; url: string }) => void | Promise<void>;
  onCancel: () => void;
}

export function LinkDialog({ initial, t, kind = "link", pathHints, onConfirm, onCancel }: Props): JSX.Element {
  const [text, setText] = useState(initial.text);
  const [url, setUrl] = useState(initial.url);
  const [original] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const textRef = useRef<HTMLInputElement | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);
  const hintsId = useId();

  useEffect(() => {
    alive.current = true;
    (original.text ? urlRef.current : textRef.current)?.focus();
    return () => { alive.current = false; };
  }, [original]);

  const cancel = () => {
    if (busyRef.current) return;
    if (text !== original.text || url !== original.url) setDiscard(true);
    else onCancel();
  };
  const ok = async () => {
    if (busyRef.current || !url.trim()) return;
    if (initial !== original) { setError(t.linkTargetChanged); return; }
    busyRef.current = true;
    setBusy(true); setError(null); setDiscard(false);
    try { await onConfirm({ text, url: url.trim() }); }
    catch (cause) { if (alive.current) setError(`${t.linkApplyFailed} ${String(cause)}`); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={kind === "image" ? t.imageEditTitle : t.linkEditTitle}
      aria-busy={busy}
      onClick={(e) => e.target === e.currentTarget && cancel()}
      onKeyDown={(e) => {
        // 버튼 등 어디에 포커스가 있어도 Esc=취소(입력 필드의 자체 핸들러와
        // 같은 규칙 — 조합 중 IME 키는 IME에게).
        if (e.key === "Escape" && !imeComposing(e)) {
          e.preventDefault(); e.stopPropagation();
          if (discard) setDiscard(false); else cancel();
        }
      }}
    >
      <div className="modal link-dialog">
        <div className="modal-title">{kind === "image" ? t.imageEditTitle : t.linkEditTitle}</div>
        <label className="settings-label">
          {kind === "image" ? t.imageEditAlt : t.linkEditText}
          <input
            ref={textRef}
            value={text}
            readOnly={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (imeComposing(e)) return; // IME 조합 중 키는 IME가 소비(한글 Esc·Enter 새기기 방지)
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation(); // 오버레이 핸들러와 이중 처리 방지
                void ok();
              }
            }}
          />
        </label>
        <label className="settings-label">
          {kind === "image" ? t.imageEditSrc : t.linkEditUrl}
          <input
            ref={urlRef}
            value={url}
            readOnly={busy}
            placeholder={kind === "image" ? "assets/…" : "https://…"}
            list={pathHints && pathHints.length > 0 ? hintsId : undefined}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (imeComposing(e)) return; // IME 조합 중 키는 IME가 소비(한글 Esc·Enter 새기기 방지)
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation(); // 오버레이 핸들러와 이중 처리 방지
                void ok();
              }
            }}
          />
        </label>
        {pathHints && pathHints.length > 0 && (
          <datalist id={hintsId}>
            {pathHints.slice(0, 60).map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        )}
        {error && <p className="comment-error" role="alert">{error}</p>}
        {discard ? <div className="comment-error" role="alert">
          <p>{t.linkDiscardPrompt}</p>
          <button className="btn" onClick={() => { setDiscard(false); textRef.current?.focus(); }}>{t.commentKeepEditing}</button>
          <button className="btn btn-plain" onClick={onCancel}>{t.commentDiscard}</button>
        </div> : <div className="modal-actions">
          <button className="btn btn-primary" onClick={() => void ok()} disabled={busy || !url.trim()}>
            {busy ? t.loading : t.save}
          </button>
          <button className="btn btn-plain" disabled={busy} onClick={cancel}>
            {t.cancel}
          </button>
        </div>}
      </div>
    </div>
  );
}
