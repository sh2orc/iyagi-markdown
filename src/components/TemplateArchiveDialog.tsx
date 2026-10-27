import { useEffect, useId, useRef, useState } from "react";
import { api, pickSave, pickTemplateArchive, type UserTemplateInput, type UserTemplateList } from "../api";
import { imeComposing } from "../app/ime";
import type { Translate } from "../i18n";
import { newTemplateDraft } from "./UserTemplateEditor";
import { templateError } from "./useUserTemplates";

export function TemplateArchiveDialog({ mode, snapshot, t, onClose, onImported }: {
  mode: "import" | "export"; snapshot: UserTemplateList; t: Translate;
  onClose: () => void; onImported: () => Promise<void>;
}): JSX.Element {
  const id = useId(), importing = mode === "import";
  // Freeze the reviewed export version while the native Save dialog is open.
  const [review, setReview] = useState(snapshot);
  const [entries, setEntries] = useState<UserTemplateInput[]>([]);
  const [selected, setSelected] = useState(() => new Set(importing ? [] : snapshot.templates.map((item) => item.id)));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), completed = useRef(false), mounted = useRef(true), composing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const rows = importing ? entries : review.templates;
  const chosen = rows.filter((item) => selected.has(item.id));
  const active = entries.find((item) => item.id === activeId) ?? entries[0];
  const cancel = () => { if (!lock.current) onClose(); };
  const begin = () => {
    if (lock.current || completed.current) return false;
    lock.current = true; setBusy(true); setError(""); setNotice(""); return true;
  };
  const finish = () => { lock.current = false; if (mounted.current) setBusy(false); };
  const chooseFile = async () => {
    if (!begin()) return;
    try {
      const file = await pickTemplateArchive();
      if (!file || !mounted.current) return;
      setEntries([]); setSelected(new Set()); setPath(""); setActiveId(null);
      const archive = await api.readTemplateArchive(file);
      if (!mounted.current) return;
      const next = archive.templates.map((item) => ({ ...newTemplateDraft(item.name, item.content), description: item.description }));
      setEntries(next); setSelected(new Set(next.map((item) => item.id))); setActiveId(next[0]?.id ?? null); setPath(file);
    } catch (reason) { if (mounted.current) setError(templateError(reason, t)); }
    finally { finish(); }
  };
  const apply = async () => {
    if (!chosen.length || composing.current || !begin()) return;
    try {
      if (importing) {
        // IDs survive retries. The database applies the whole batch atomically.
        await api.importTemplateArchive(entries.filter((item) => selected.has(item.id)));
        completed.current = true;
        if (mounted.current) setNotice(t.templateArchiveImported);
        if (mounted.current) await onImported();
      } else {
        const output = await pickSave("iyagi-templates.json", "json");
        if (!output || !mounted.current) return;
        await api.exportTemplateArchive(output, chosen.map((item) => item.id), review.revision);
        if (mounted.current) setNotice(`${t.templateArchiveExported} ${output}`);
      }
    } catch (reason) {
      if (!mounted.current) return;
      if (completed.current) { setError(t.userTemplateLoadFailed); return; }
      setError(templateError(reason, t));
      if (!importing && typeof reason === "object" && reason !== null && "code" in reason && reason.code === "changed") {
        try {
          const latest = await api.listUserTemplates();
          if (mounted.current) {
            setReview(latest); setSelected((previous) => new Set(latest.templates.filter((item) => previous.has(item.id)).map((item) => item.id)));
            setError(t.templateArchiveChanged);
          }
        } catch { if (mounted.current) setError(t.userTemplateLoadFailed); }
      }
    } finally { finish(); }
  };
  return <div className="overlay modal-overlay" role="dialog" aria-modal="true" aria-busy={busy}
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`}
    onClick={(event) => { if (event.target === event.currentTarget) cancel(); }}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={(event) => {
      if (imeComposing(event) || composing.current) { event.stopPropagation(); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
      if (event.key === "Enter" && event.repeat) event.preventDefault();
    }}>
    <div className="modal template-archive-dialog">
      <h2 className="modal-title" id={`${id}-title`}>{importing ? t.templateArchiveImport : t.templateArchiveExport}</h2>
      <p className="modal-hint" id={`${id}-hint`}>{importing ? t.templateArchiveImportHint : t.templateArchiveExportHint}</p>
      {importing && <button autoFocus className="btn" disabled={busy || completed.current} onClick={() => void chooseFile()}>{t.templateArchiveChoose}</button>}
      {path && <p className="modal-text template-archive-path">{path}</p>}
      {rows.length > 0 && <>
        <div className="template-archive-selection">
          <button autoFocus={!importing} className="btn btn-plain" disabled={busy} onClick={() => setSelected(new Set(rows.map((item) => item.id)))}>{t.templateArchiveSelectAll}</button>
          <button className="btn btn-plain" disabled={busy} onClick={() => setSelected(new Set())}>{t.templateArchiveSelectNone}</button>
          <span role="status">{t.templateArchiveSelected}: {chosen.length} / {rows.length}</span>
        </div>
        <div className={`template-archive-review ${importing ? "is-import" : ""}`}>
          <ul aria-label={t.templateList} className="template-archive-list">
            {rows.map((item) => <li key={item.id}>
              <label><input type="checkbox" disabled={busy} checked={selected.has(item.id)} onChange={(event) => {
                const checked = event.target.checked;
                setSelected((previous) => { const next = new Set(previous); if (checked) next.add(item.id); else next.delete(item.id); return next; });
              }} /> <strong>{item.name}</strong><span>{item.description}</span></label>
              {importing && <button className="btn btn-plain" disabled={busy} aria-pressed={active?.id === item.id}
                onClick={() => setActiveId(item.id)}>{t.templateSource}: {item.name}</button>}
            </li>)}
          </ul>
          {importing && active && <section aria-label={`${t.templateSource}: ${active.name}`} className="template-archive-source" tabIndex={0}>
            <h3>{active.name}</h3><pre className="template-source">{active.content || t.templateBlank}</pre>
          </section>}
        </div>
      </>}
      {!rows.length && !busy && <p className="modal-hint">{importing ? t.templateArchiveChooseHint : t.templateArchiveEmpty}</p>}
      {busy && <p role="status" className="modal-hint">{t.loading}</p>}
      {error && <p role="alert" className="modal-text close-error">{error}</p>}
      {notice && <p role="status" className="modal-text">{notice}</p>}
      <div className="modal-actions">
        <button className="btn btn-plain" disabled={busy} onClick={cancel}>{t.cancel}</button>
        <button className="btn btn-primary" disabled={busy || completed.current || !chosen.length} onClick={() => void apply()}>
          {importing ? t.templateArchiveImportSelected : t.templateArchiveExportSelected} ({chosen.length})
        </button>
      </div>
    </div>
  </div>;
}
