import { useEffect, useId, useRef, useState } from "react";
import { api, type UserTemplate, type UserTemplateInput } from "../api";
import { imeComposing } from "../app/ime";
import type { Translate } from "../i18n";
import { templateError } from "./useUserTemplates";

export type TemplateDraft = { id: string; name: string; description: string; content: string; expectedVersion: number | null };
let sequence = 0;
function templateId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `template-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${sequence++}`;
}
export function newTemplateDraft(name = "", content = ""): TemplateDraft {
  return { id: templateId(), name, content, description: "", expectedVersion: null };
}

export function UserTemplateEditor({ draft, t, onClose, onSaved }: {
  draft: TemplateDraft; t: Translate; onClose: () => void; onSaved: (template: UserTemplate) => Promise<void>;
}): JSX.Element {
  const id = useId();
  const [fields, setFields] = useState<UserTemplateInput>(draft);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [discard, setDiscard] = useState(false);
  const busyRef = useRef(false), mounted = useRef(true), completed = useRef(false), composing = useRef(false);
  const dirty = fields.name !== draft.name || fields.description !== draft.description || fields.content !== draft.content;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const cancel = () => { if (busyRef.current) return; if (dirty) setDiscard(true); else onClose(); };
  const save = async (asCopy = false) => {
    if (busyRef.current || completed.current || composing.current) return;
    if (!fields.name.trim() || [...fields.name.trim()].length > 100 || [...fields.description.trim()].length > 300
      || /[\x00-\x1f\x7f-\x9f]/.test(fields.name + fields.description)) { setError(t.userTemplateInvalid); return; }
    if (fields.content.length > 512 * 1024 || new TextEncoder().encode(fields.content).length > 512 * 1024) {
      setError(t.userTemplateTooLarge); return;
    }
    busyRef.current = true; setBusy(true); setError("");
    const input = asCopy ? { ...fields, id: templateId(), expectedVersion: null } : fields;
    if (asCopy) setFields(input); // Keep the new identity even if the response is lost.
    let result: UserTemplate;
    try { result = await api.putUserTemplate(input); }
    catch (reason) {
      if (mounted.current) { setError(templateError(reason, t)); setBusy(false); }
      busyRef.current = false; return;
    }
    completed.current = true;
    // Persistence has succeeded. A subsequent list refresh is not a failed save.
    if (mounted.current) await onSaved(result);
  };
  return <div className="overlay modal-overlay" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={busy}
    onClick={(event) => { if (event.target === event.currentTarget) cancel(); }}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={(event) => {
      if (imeComposing(event) || composing.current) { event.stopPropagation(); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (discard) setDiscard(false); else cancel(); }
      if (event.key === "Enter" && event.repeat && event.target instanceof HTMLButtonElement) event.preventDefault();
    }}>
    <div className="modal user-template-editor">
      <h2 className="modal-title" id={`${id}-title`}>{fields.expectedVersion === null ? t.userTemplateNew : t.userTemplateEdit}</h2>
      <p className="modal-hint">{t.userTemplateContentHint}</p>
      <label className="settings-label">{t.userTemplateName}<input autoFocus disabled={busy} value={fields.name} maxLength={200}
        onChange={(event) => { setFields({ ...fields, name: event.target.value }); setError(""); }} /></label>
      <label className="settings-label">{t.userTemplateDescription}<input disabled={busy} value={fields.description} maxLength={600}
        onChange={(event) => { setFields({ ...fields, description: event.target.value }); setError(""); }} /></label>
      <label className="settings-label user-template-body">{t.templateSource}<textarea disabled={busy} spellCheck={false}
        value={fields.content} onChange={(event) => { setFields({ ...fields, content: event.target.value }); setError(""); }} /></label>
      {error && <p className="modal-text close-error" role="alert">{error}</p>}
      {discard ? <div className="user-template-discard" role="alert">
        <p>{t.userTemplateDiscard}</p>
        <button className="btn" autoFocus onClick={() => setDiscard(false)}>{t.userTemplateKeepEditing}</button>
        <button className="btn" onClick={onClose}>{t.userTemplateDiscardAction}</button>
      </div> : <div className="modal-actions">
        <button className="btn btn-plain" disabled={busy} onClick={cancel}>{t.cancel}</button>
        {fields.expectedVersion !== null && <button className="btn" disabled={busy || !fields.name.trim()}
          onClick={() => void save(true)}>{t.userTemplateSaveCopy}</button>}
        <button className="btn btn-primary" disabled={busy || !fields.name.trim()} onClick={() => void save()}>{busy ? t.loading : t.userTemplateSave}</button>
      </div>}
    </div>
  </div>;
}
