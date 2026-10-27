import { useEffect, useId, useMemo, useRef, useState } from "react";
import { DOC_TEMPLATES, templateContent, templateDescription, templateName, templateOutline } from "../app/templates";
import { imeComposing } from "../app/ime";
import type { Translate } from "../i18n";
import { api, isInApp, type UserTemplate, type UserTemplateInfo } from "../api";
import { useUserTemplates, templateError } from "./useUserTemplates";
import { UserTemplateEditor, newTemplateDraft, type TemplateDraft } from "./UserTemplateEditor";
import type { DocTemplate } from "../app/templates";
import { UserTemplatePreview } from "./UserTemplatePreview";
import { TemplateArchiveDialog } from "./TemplateArchiveDialog";

type Choice = DocTemplate & { user?: UserTemplateInfo };

interface Props {
  t: Translate;
  theme: "light" | "dark";
  initialId?: string;
  onCreate: (content: string) => void;
  onClose: () => void;
  captureDocument?: () => { name: string; content: string } | null;
}

export function TemplatePicker({ t, theme, initialId, onCreate, onClose, captureDocument }: Props): JSX.Element {
  const id = useId();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(initialId ?? "blank");
  const [source, setSource] = useState(false);
  const [error, setError] = useState(false);
  const [preview, setPreview] = useState<{ content: string; html: string; failed: boolean } | null>(null);
  const completed = useRef(false), composing = useRef(false);
  const choices = useRef(new Map<string, HTMLButtonElement>());
  const library = useUserTemplates();
  const [editor, setEditor] = useState<TemplateDraft | null>(null);
  const [archiveMode, setArchiveMode] = useState<"import" | "export" | null>(null);
  const [record, setRecord] = useState<UserTemplate | null>(null);
  const [recordError, setRecordError] = useState("");
  const [recordRetry, setRecordRetry] = useState(0);
  const [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<UserTemplateInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const deleteLock = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const templates = useMemo<Choice[]>(() => [
    ...DOC_TEMPLATES,
    ...library.list.templates.map((item) => ({
      id: `user:${item.id}`, user: item, nameKo: item.name, nameEn: item.name,
      descriptionKo: item.description, descriptionEn: item.description, content: "",
    })),
  ], [library.list.templates]);
  const filtered = useMemo(() => {
    const terms = query.normalize("NFC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return templates.filter((template) => {
      const text = [template.nameKo, template.nameEn, templateDescription(template, t.lang), templateOutline(template, t.lang)]
        .join(" ").normalize("NFC").toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [query, t.lang, templates]);
  const missingSelection = selectedId.startsWith("user:") && !templates.some((template) => template.id === selectedId);
  const selected = filtered.find((template) => template.id === selectedId) ?? (missingSelection ? undefined : filtered[0]);
  const selectedUser = selected?.user;
  const { reload } = library;
  useEffect(() => {
    setRecord(null); setRecordError("");
    if (!selectedUser) return;
    let current = true;
    void api.getUserTemplate(selectedUser.id).then((value) => {
      if (!current) return;
      if (value.version !== selectedUser.version) { setRecordError(t.userTemplateChanged); void reload(); }
      else setRecord(value);
    }).catch((reason) => { if (current) setRecordError(templateError(reason, t)); });
    return () => { current = false; };
  }, [selectedUser?.id, selectedUser?.version, recordRetry, reload, t]);
  const ready = !selectedUser || record?.id === selectedUser.id && record.version === selectedUser.version;
  // Keep the displayed selection when clearing a search, instead of silently
  // returning to the template selected before that search.
  useEffect(() => { if (selected) setSelectedId(selected.id); }, [selected]);
  const content = useMemo(() => selectedUser ? ready ? record!.content : ""
    : selected ? templateContent(selected, t.lang) : "", [selected, selectedUser, ready, record, t.lang]);
  useEffect(() => {
    if (!selected || !content || source || editor || archiveMode) return;
    let current = true;
    setPreview(null);
    void import("../export/html").then(({ renderExportBody }) => {
      if (!current) return undefined;
      return renderExportBody(content, {
        title: templateName(selected, t.lang), baseDir: "", theme, lang: t.lang, inlineImages: false,
        renderDiagrams: !selectedUser,
      });
    }).then(async (html) => {
      if (current && html !== undefined && selectedUser) {
        // User Markdown stays in a sandboxed preview. Remove navigation and form
        // targets as well as using CSP to prevent image/font/network requests.
        const { default: purify } = await import("dompurify");
        // Preserve task status while keeping all form controls out of a preview.
        html = html.replace(/<input\b[^>]*>/gi, (tag) => /\btype\s*=\s*["']?checkbox\b/i.test(tag)
          ? /\bchecked(?:\s*=|[\s/>])/i.test(tag) ? "☑ " : "☐ " : "");
        html = purify.sanitize(html, {
          FORBID_ATTR: ["href", "xlink:href", "action", "formaction", "tabindex", "contenteditable", "autofocus"],
          FORBID_TAGS: ["form", "input", "button", "textarea", "select", "iframe", "object", "embed", "meta", "base", "animate", "set"],
        });
      }
      if (current && html !== undefined) setPreview({ content, html, failed: false });
    }).catch(() => {
      if (current) setPreview({ content, html: "", failed: true });
    });
    return () => { current = false; };
  }, [content, selected, selectedUser, source, t.lang, theme, editor, archiveMode]);
  const currentPreview = preview?.content === content ? preview : null;
  const choose = (templateId: string, focus = false) => {
    setSelectedId(templateId); setError(false); setNotice(""); setDeleting(null);
    if (focus) choices.current.get(templateId)?.focus();
  };
  const create = () => {
    if (!selected || !ready || deleting || completed.current || composing.current || deleteLock.current) return;
    completed.current = true;
    try {
      // Generate again at confirmation: the picker itself may stay open overnight.
      onCreate(selectedUser ? record!.content : templateContent(selected, t.lang));
    } catch {
      completed.current = false; setError(true); return;
    }
    onClose();
  };
  const remove = async () => {
    if (!deleting || deleteLock.current || composing.current) return;
    deleteLock.current = true; setDeleteBusy(true); setNotice("");
    try {
      await api.deleteUserTemplate(deleting.id, deleting.version);
      await reload();
      if (mounted.current) { setDeleting(null); setSelectedId("blank"); setQuery(""); setNotice(t.userTemplateDeleted); }
    } catch (reason) {
      if (mounted.current) { setNotice(templateError(reason, t)); setDeleting(null); void reload(); }
    } finally {
      deleteLock.current = false; if (mounted.current) setDeleteBusy(false);
    }
  };
  if (archiveMode) return <TemplateArchiveDialog mode={archiveMode} snapshot={library.list} t={t}
    onClose={() => setArchiveMode(null)} onImported={async () => {
      await reload();
      if (mounted.current) { setArchiveMode(null); setQuery(""); setNotice(t.templateArchiveImported); }
    }} />;
  if (editor) return <UserTemplateEditor draft={editor} t={t} onClose={() => setEditor(null)} onSaved={async (saved) => {
    await reload();
    if (mounted.current) { setQuery(""); setSelectedId(`user:${saved.id}`); setEditor(null); setNotice(t.userTemplateSaved); }
  }} />;
  const close = () => { if (!deleteLock.current) { if (deleting) setDeleting(null); else onClose(); } };
  return <div className="overlay modal-overlay" role="dialog" aria-modal="true"
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`}
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={(event) => {
      if (imeComposing(event) || composing.current) { event.stopPropagation(); return; }
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key === "Enter" && event.repeat) event.preventDefault();
    }}>
    <div className="modal template-picker">
      <h2 className="modal-title" id={`${id}-title`}>{t.newFromTemplate}</h2>
      <p className="modal-hint" id={`${id}-hint`}>{t.templateHint}</p>
      {isInApp() && <div className="template-library-actions">
        <button className="btn" disabled={deleteBusy || !!deleting} onClick={() => setEditor(newTemplateDraft())}>{t.userTemplateNew}</button>
        {captureDocument && <button className="btn" disabled={deleteBusy || !!deleting} onClick={() => {
          try { const value = captureDocument(); if (value) setEditor(newTemplateDraft(value.name, value.content)); }
          catch (reason) { setNotice(templateError(reason, t)); }
        }}>{t.userTemplateFromDocument}</button>}
        <button className="btn btn-plain" disabled={library.loading || deleteBusy} onClick={() => void reload()}>{t.userTemplateRefresh}</button>
        <button className="btn btn-plain" disabled={deleteBusy || !!deleting} onClick={() => setArchiveMode("import")}>{t.templateArchiveImport}</button>
        <button className="btn btn-plain" disabled={deleteBusy || !!deleting || library.loading || !library.list.templates.length}
          onClick={() => setArchiveMode("export")}>{t.templateArchiveExport}</button>
      </div>}
      {(library.error || library.syncError) && <p role="alert" className="modal-text close-error">{library.error ? t.userTemplateLoadFailed : t.userTemplateSyncFailed}</p>}
      {library.loading && <p role="status" className="modal-hint">{t.loading}</p>}
      {notice && <p role="status" className="modal-hint">{notice}</p>}
      <div className="template-browser">
        <div className="template-sidebar">
          <input autoFocus type="search" className="palette-input" aria-label={t.templateSearch}
            placeholder={t.templateSearch} value={query} disabled={deleteBusy || !!deleting}
            onChange={(event) => { setQuery(event.target.value); setError(false); }}
            onKeyDown={(event) => {
              if (imeComposing(event) || composing.current) return;
              if (event.key === "ArrowDown" && selected) { event.preventDefault(); choices.current.get(selected.id)?.focus(); }
            }} />
          <div className="template-list" role="radiogroup" aria-label={t.templateList}>
            {filtered.map((template, index) => <button type="button" key={template.id} role="radio"
              aria-checked={selected?.id === template.id} tabIndex={selected?.id === template.id ? 0 : -1}
              disabled={deleteBusy || !!deleting}
              className="template-choice" ref={(node) => { if (node) choices.current.set(template.id, node); else choices.current.delete(template.id); }}
              onClick={() => choose(template.id)}
              onKeyDown={(event) => {
                if (imeComposing(event) || composing.current || event.altKey || event.ctrlKey || event.metaKey) return;
                let next: number;
                switch (event.key) {
                  case "ArrowDown": case "ArrowRight": next = (index + 1) % filtered.length; break;
                  case "ArrowUp": case "ArrowLeft": next = (index - 1 + filtered.length) % filtered.length; break;
                  case "Home": next = 0; break;
                  case "End": next = filtered.length - 1; break;
                  default: return;
                }
                event.preventDefault(); choose(filtered[next].id, true);
              }}>
              <strong>{templateName(template, t.lang)}</strong>
              <span>{templateDescription(template, t.lang)}</span>
              {template.user && <small>{t.userTemplateLabel}</small>}
            </button>)}
          </div>
          {!filtered.length && <p role="status" className="modal-hint">{t.templateEmpty}</p>}
        </div>
        <section className="template-detail" aria-label={t.templatePreview}>
          {missingSelection && !library.loading && <p role="status" className="modal-hint">{t.userTemplateUnavailable}</p>}
          {selected && <>
            <div className="template-preview-toolbar">
              <h3>{templateName(selected, t.lang)}</h3>
              {selectedUser && <>
                <button className="btn btn-plain" disabled={!ready || deleteBusy || !!deleting} onClick={() => {
                  if (record) setEditor({ id: record.id, name: record.name, description: record.description, content: record.content, expectedVersion: record.version });
                }}>{t.userTemplateEdit}</button>
                <button className="btn btn-plain" disabled={!ready || deleteBusy || !!deleting} onClick={() => { setDeleting(selectedUser); setNotice(""); }}>{t.userTemplateDelete}</button>
              </>}
              <button type="button" className="btn btn-plain" aria-pressed={source}
                onClick={() => setSource((value) => !value)}>{t.templateSource}</button>
            </div>
            <div className="template-preview-scroll" tabIndex={0} aria-label={source ? t.templateSource : t.templatePreview}>
              {selectedUser && <p className="modal-hint">{t.userTemplateContentHint}</p>}
              {!ready ? <div role="status"><p className="modal-hint">{recordError || t.loading}</p>
                {recordError && <button className="btn" onClick={() => { setRecordRetry((value) => value + 1); void reload(); }}>{t.wsRetry}</button>}</div>
                : !content ? <p className="modal-hint">{t.templateBlank}</p>
                : source ? <pre className="template-source">{content}</pre>
                : currentPreview?.failed ? <>
                  <p role="status" className="modal-hint">{t.templatePreviewFailed}</p>
                  <pre className="template-source">{content}</pre>
                </> : currentPreview ? selectedUser
                  ? <UserTemplatePreview html={currentPreview.html} title={t.templatePreview} theme={theme} />
                  : <div className="template-preview" onClick={(event) => event.preventDefault()} dangerouslySetInnerHTML={{ __html: currentPreview.html }} />
                : <p role="status" className="modal-hint">{t.loading}</p>}
            </div>
          </>}
        </section>
      </div>
      {error && <p role="alert" className="modal-text close-error">{t.templateCreateFailed}</p>}
      {deleting && <div className="user-template-discard" role="alert">
        <p>{t.userTemplateDeleteConfirm} <strong>{deleting.name}</strong></p>
        <button className="btn" autoFocus disabled={deleteBusy} onClick={() => setDeleting(null)}>{t.cancel}</button>
        <button className="btn" disabled={deleteBusy} onClick={() => void remove()}>{deleteBusy ? t.loading : t.userTemplateDelete}</button>
      </div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-plain" disabled={deleteBusy} onClick={close}>{t.cancel}</button>
        <button type="button" className="btn btn-primary" disabled={!selected || !ready || deleteBusy || !!deleting} onClick={create}>{t.templateCreate}</button>
      </div>
    </div>
  </div>;
}
