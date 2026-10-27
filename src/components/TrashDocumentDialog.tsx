import { useEffect, useRef, useState } from "react";
import { api, type TrashDocument } from "../api";
import type { AppStore } from "../app/store";
import { imeComposing } from "../app/ime";
import type { Translate } from "../i18n";

function message(reason: unknown, t: Translate): string {
  if (typeof reason === "object" && reason !== null && "code" in reason) {
    switch (reason.code) {
      case "changed": return t.trashChanged;
      case "outside": return t.trashOutside;
      case "otherWindows": return t.trashOtherWindows;
      case "recoveryUnavailable": return t.trashRecoveryUnavailable;
    }
  }
  const detail = reason instanceof Error ? reason.message
    : typeof reason === "object" && reason !== null && "message" in reason ? String(reason.message)
    : typeof reason === "string" ? reason : "";
  return detail ? `${t.trashFailed}: ${detail}` : t.trashFailed;
}

export function TrashDocumentDialog({ store, root, path, isCurrent, t, onClose }: {
  store: AppStore; root: string; path: string; isCurrent: () => boolean;
  t: Translate; onClose: () => void;
}): JSX.Element {
  const [reviewed, setReviewed] = useState<TrashDocument | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true), [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true), busyRef = useRef(false), completed = useRef(false);
  const currentRef = useRef(isCurrent); currentRef.current = isCurrent;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    let disposed = false;
    setChecking(true); setReviewed(null); setError("");
    void api.reviewDocumentTrash(root, path).then((result) => {
      if (disposed) return;
      if (!currentRef.current() || store.state.workspace !== root) { setError(t.trashChanged); return; }
      setReviewed(result);
    }).catch((reason: unknown) => { if (!disposed) setError(message(reason, t)); })
      .finally(() => { if (!disposed) setChecking(false); });
    return () => { disposed = true; };
  }, [root, path, revision, store, t]);

  const move = async () => {
    if (busyRef.current || completed.current || !reviewed) return;
    if (!isCurrent() || store.state.workspace !== root) { setReviewed(null); setError(t.trashChanged); return; }
    busyRef.current = true; setBusy(true); setError("");
    try {
      await store.trashDocument(reviewed, () => mounted.current && currentRef.current());
      completed.current = true;
      store.toast(`${t.trashDone}: ${path}`);
      if (mounted.current) onClose();
    } catch (reason) {
      if (mounted.current) { setReviewed(null); setError(message(reason, t)); }
      else store.toast(message(reason, t), "error");
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="overlay modal-overlay" role="dialog" aria-modal="true"
    aria-labelledby="trash-document-title" aria-describedby="trash-document-hint" aria-busy={busy || checking}
    onClick={(event) => { if (event.target === event.currentTarget && !busyRef.current) onClose(); }}
    onKeyDown={(event) => {
      if (imeComposing(event)) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (!busyRef.current) onClose();
      }
    }}>
    <div className="modal">
      <div className="modal-title" id="trash-document-title">{t.trashTitle}</div>
      <p className="modal-text"><code className="modal-file">{path}</code></p>
      <p className="modal-hint" id="trash-document-hint">{t.trashHint}</p>
      <p className="modal-hint">{t.trashBufferHint}</p>
      {(checking || busy) && <p className="modal-hint" role="status">{busy ? t.trashMoving : t.trashChecking}</p>}
      {error && <p className="modal-text close-error" role="alert">{error}</p>}
      <div className="modal-actions">
        {reviewed ? <button className="btn btn-danger" disabled={busy || checking}
          onClick={() => void move()}>{t.trashAction}</button>
          : <button className="btn btn-plain" disabled={busy || checking || !isCurrent()}
            onClick={() => setRevision((value) => value + 1)}>{t.trashReview}</button>}
        <button autoFocus className="btn btn-plain" disabled={busy}
          onClick={() => { if (!busyRef.current && !completed.current) onClose(); }}>{t.cancel}</button>
      </div>
    </div>
  </div>;
}
