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
  /** link = [텍스트](url), image = ![대체텍스트](src) — 라벨만 달라진다. */
  kind?: "link" | "image";
  /** URL 자동완성 후보(문서 폴더 상대 경로) — 없으면 datalist 생략. */
  pathHints?: string[];
  onConfirm: (next: { text: string; url: string }) => void;
  onCancel: () => void;
}

export function LinkDialog({ initial, t, kind = "link", pathHints, onConfirm, onCancel }: Props): JSX.Element {
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
        <div className="modal-title">{kind === "image" ? t.imageEditTitle : t.linkEditTitle}</div>
        <label className="settings-label">
          {kind === "image" ? t.imageEditAlt : t.linkEditText}
          <input value={text} onChange={(e) => setText(e.target.value)} autoFocus={!initial.text} />
        </label>
        <label className="settings-label">
          {kind === "image" ? t.imageEditSrc : t.linkEditUrl}
          <input
            ref={urlRef}
            value={url}
            placeholder={kind === "image" ? "assets/…" : "https://…"}
            list={pathHints && pathHints.length > 0 ? "iyagi-link-hints" : undefined}
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
        {pathHints && pathHints.length > 0 && (
          <datalist id="iyagi-link-hints">
            {pathHints.slice(0, 60).map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        )}
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
