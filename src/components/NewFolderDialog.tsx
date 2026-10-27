import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AppStore } from "../app/store";
import { imeComposing } from "../app/ime";
import type { Translate } from "../i18n";

function errorMessage(error: unknown, t: Translate): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    switch (error.code) {
      case "invalidName": return t.folderInvalidName;
      case "hiddenName": return t.folderHiddenName;
      case "exists": return t.folderExists;
      case "outside": return t.folderTargetChanged;
      case "depth": return t.folderDepth;
    }
  }
  const detail = error instanceof Error ? error.message
    : typeof error === "object" && error !== null && "message" in error ? String(error.message)
    : typeof error === "string" ? error : "";
  return detail ? `${t.folderCreateFailed}: ${detail}` : t.folderCreateFailed;
}

export function NewFolderDialog({ store, root, dir, t, onClose, onCreated }: {
  store: AppStore; root: string; dir: string; t: Translate;
  onClose: () => void; onCreated: (path: string) => void;
}): JSX.Element {
  const [name, setName] = useState(""), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false), completed = useRef(false), mounted = useRef(true);
  const composing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const create = async () => {
    if (busyRef.current || completed.current) return;
    if (store.state.workspace !== root) { setError(t.folderTargetChanged); return; }
    const filename = name.trim();
    if (!filename || filename === "." || filename === ".." || /[/\\\x00-\x1f\x7f-\x9f]/.test(filename)) {
      setError(t.folderInvalidName); return;
    }
    busyRef.current = true; setBusy(true); setError("");
    try {
      const path = await api.newFolderIn(root, dir, filename);
      completed.current = true;
      store.toast(`${t.folderCreated}: ${path}`);
      if (mounted.current && store.state.workspace === root) onCreated(path);
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason, t));
      else store.toast(errorMessage(reason, t), "error");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return <div className="overlay modal-overlay" role="dialog" aria-modal="true"
    aria-labelledby="new-folder-title" aria-describedby="new-folder-location" aria-busy={busy}
    onClick={(event) => { if (event.target === event.currentTarget && !busyRef.current) onClose(); }}
    onKeyDown={(event) => {
      if (imeComposing(event) || composing.current) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (!busyRef.current) onClose();
      }
    }}>
    <div className="modal folder-dialog">
      <div className="modal-title" id="new-folder-title">{t.ctxNewFolder}</div>
      <p className="modal-text" id="new-folder-location">{t.folderLocation}<br /><code className="modal-file">{dir}</code></p>
      <form onSubmit={(event) => { event.preventDefault(); if (!composing.current) void create(); }}>
        <input className="palette-input" autoFocus aria-label={t.folderName} placeholder={t.folderName}
          disabled={busy} value={name} aria-invalid={!!error} aria-describedby={error ? "new-folder-error" : undefined}
          onChange={(event) => { setName(event.target.value); setError(""); }}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (!imeComposing(event) && event.key === "Enter" && event.repeat) event.preventDefault();
          }} />
        {busy && <p className="modal-hint" role="status">{t.folderCreating}</p>}
        {error && <p className="modal-text close-error" id="new-folder-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? t.folderCreating : t.folderCreate}</button>
          <button type="button" className="btn btn-plain" disabled={busy} onClick={onClose}>{t.cancel}</button>
        </div>
      </form>
    </div>
  </div>;
}

