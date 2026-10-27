import { useEffect, useRef, useState } from "react";
import type { ExportResult } from "../export/result";
import type { Translate } from "../i18n";

export function ExportFeedback({ busy, result, t, onReveal }: {
  busy: boolean; result: ExportResult | null; t: Translate; onReveal?: (path: string) => Promise<void>;
}): JSX.Element | null {
  const [revealError, setRevealError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const running = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (busy) return <p className="export-feedback" role="status">{t.exportPreparing}</p>;
  if (!result) return null;
  if (result.status === "failed") return <p className="export-feedback" role="alert">{t.exportFailed}: {result.message}</p>;
  if (result.status === "cancelled") return <p className="export-feedback" role="status">{t.exportCancelled}</p>;
  return <div className="export-feedback">
    <p role="status">{t.exportSavedTo}</p>
    <p className="export-output-path">{result.path}</p>
    {onReveal && <button className="btn" disabled={revealing} onClick={() => {
      if (running.current) return;
      running.current = true; setRevealing(true); setRevealError(null);
      void Promise.resolve().then(() => onReveal(result.path)).catch((error: unknown) => {
        if (mounted.current) setRevealError(error instanceof Error ? error.message : String(error));
      }).finally(() => {
        running.current = false;
        if (mounted.current) setRevealing(false);
      });
    }}>{t.tabReveal}</button>}
    {revealError && <p role="alert">{t.exportRevealFailed}: {revealError}</p>}
  </div>;
}
