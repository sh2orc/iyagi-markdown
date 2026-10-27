import { useCallback, useEffect, useRef, useState } from "react";
import { api, onUserTemplatesChanged, type UserTemplateList } from "../api";
import type { Translate } from "../i18n";

export function templateError(error: unknown, t: Translate): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    switch (error.code) {
      case "changed": case "missing": return t.userTemplateChanged;
      case "tooLarge": return t.userTemplateTooLarge;
      case "limit": return t.userTemplateLimit;
      case "invalid": return t.userTemplateInvalid;
      case "archiveInvalid": return t.templateArchiveInvalid;
      case "archiveTooLarge": return t.templateArchiveTooLarge;
    }
  }
  return t.userTemplateFailed;
}

/** Metadata only; bodies are fetched for the selected template, never on startup. */
export function useUserTemplates() {
  const [list, setList] = useState<UserTemplateList>({ revision: -1, templates: [] });
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const mounted = useRef(false), request = useRef(0), knownRevision = useRef(-1);
  const reload = useCallback(async () => {
    const seq = ++request.current;
    if (mounted.current) setLoading(true);
    try {
      const result = await api.listUserTemplates();
      if (mounted.current && request.current === seq && result.revision >= knownRevision.current) {
        knownRevision.current = result.revision; setList(result); setError(false);
      }
    } catch {
      if (mounted.current && request.current === seq) setError(true);
    } finally {
      if (mounted.current && request.current === seq) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let disposed = false, unlisten: (() => void) | undefined;
    void onUserTemplatesChanged((revision) => {
      if (disposed || revision <= knownRevision.current) return;
      knownRevision.current = revision; void reload();
    }).then((stop) => {
      if (disposed) { stop(); return; }
      unlisten = stop; setSyncError(false); void reload();
    }).catch(() => {
      if (!disposed) { setSyncError(true); void reload(); }
    });
    // Also reconcile on returning to this window, including a missed event.
    const focus = () => { void reload(); };
    window.addEventListener("focus", focus);
    return () => { disposed = true; mounted.current = false; request.current++; unlisten?.(); window.removeEventListener("focus", focus); };
  }, [reload]);
  return { list, loading, error, syncError, reload };
}
