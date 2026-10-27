// Print uses the same immutable document snapshot and options as PDF export.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import { captureExportSnapshot, type ExportSnapshot } from "../export/snapshot";
import { createPreviewRenderer, paperDimensions, snapshotHtmlOptions, type PdfOptions } from "../export/preview";
import { imeComposing } from "../app/ime";
import { connectPrintFrame } from "../export/printFrame";
import type { ExportResult } from "../export/result";
import { useExportTask } from "./useExportTask";
import { ExportFeedback } from "./ExportFeedback";

interface Props {
  store: AppStore;
  t: Translate;
  onExport: (kind: "pdf", opts: PdfOptions, snapshot: ExportSnapshot, html: string) => Promise<ExportResult>;
  onReveal?: (path: string) => Promise<void>;
  onCancel: () => void;
  saved?: { paper: "a4" | "letter" | "a5"; landscape?: boolean; margin: number; scale: number };
}
const readBytes = async (path: string): Promise<Uint8Array | null> => {
  try { return new Uint8Array(await api.readFileBytes(path)); } catch { return null; }
};

export function PrintPreview({ store, t, onExport, onReveal, onCancel, saved }: Props): JSX.Element | null {
  const task = useExportTask();
  const cancel = () => { if (!task.isRunning()) onCancel(); };
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const tab = store.active;
  const [paper, setPaper] = useState<PdfOptions["paper"]>(saved?.paper ?? "a4");
  const [orientation, setOrientation] = useState<PdfOptions["orientation"]>(saved?.landscape ? "landscape" : "portrait");
  const [margin, setMargin] = useState(saved?.margin ?? 14);
  const [scale, setScale] = useState(saved?.scale ?? 1);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [printError, setPrintError] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const frameCleanup = useRef<(() => void) | null>(null);
  const scroll = useRef(0);
  const renderer = useRef<ReturnType<typeof createPreviewRenderer> | null>(null);
  if (!renderer.current) renderer.current = createPreviewRenderer();
  const snapshot = useMemo(() => tab ? captureExportSnapshot(tab, {
    workspace: state.workspace, theme: "light", pageNumbers: state.settings.exportPageNumbers,
    header: state.settings.exportHeader, wikiIndex: store.wikiIndex, lang: t.lang,
  }) : null, [tab, tab?.state.doc, tab?.path, tab?.title, tab?.docStyle, state.workspace,
    state.settings.exportPageNumbers, state.settings.exportHeader, store.wikiIndex, state.linksRevision, t.lang]);
  const options = useMemo(() => ({ paper, orientation, marginMm: margin, scale }), [paper, orientation, margin, scale]);
  const request = useMemo(() => ({ snapshot, options, retry }), [snapshot, options, retry]);
  const currentRequest = useRef(request);
  currentRequest.current = request;
  const [result, setResult] = useState<{ request: typeof request; html: string; version: number } | null>(null);
  const [loaded, setLoaded] = useState<typeof request | null>(null);
  const ready = !!snapshot && !error && result?.request === request && loaded === request;

  useEffect(() => {
    let alive = true;
    setError(null); setPrintError(false);
    const timer = setTimeout(() => {
      if (!snapshot) return;
      void renderer.current!(snapshot, snapshotHtmlOptions(snapshot, readBytes, options))
        .then((html) => { if (alive) setResult((previous) => ({ request, html, version: (previous?.version ?? 0) + 1 })); })
        .catch((reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)); });
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [request, snapshot, options]);
  useEffect(() => { scroll.current = 0; }, [tab?.id]);
  useEffect(() => () => { frameCleanup.current?.(); }, []);
  if (!snapshot) return null;
  const [width] = paperDimensions(options);
  const retryRender = () => { renderer.current = createPreviewRenderer(); setRetry((value) => value + 1); };

  return <div className="overlay print-overlay" role="dialog" aria-modal="true" aria-label={t.printPreviewTitle}
    aria-busy={task.busy} onClick={(event) => { if (event.target === event.currentTarget) cancel(); }}
    onKeyDown={(event) => {
      if (imeComposing(event)) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    }}>
    <div className="print-frame">
      <div className="print-head">
        <span className="print-title">{t.printPreviewTitle}</span>
        <select className="print-paper" value={paper} aria-label={t.exportPaper} disabled={task.busy || task.complete}
          onChange={(event) => setPaper(event.target.value as PdfOptions["paper"])}>
          <option value="a4">A4</option><option value="letter">Letter</option><option value="a5">A5</option>
        </select>
        <select className="print-paper" value={orientation} aria-label={t.exportOrientation} disabled={task.busy || task.complete}
          onChange={(event) => setOrientation(event.target.value as PdfOptions["orientation"])}>
          <option value="portrait">{t.exportPortrait}</option><option value="landscape">{t.exportLandscape}</option>
        </select>
        <label className="print-ctl">{t.exportMargin} ({margin}mm)
          <input type="range" min={0} max={30} value={margin} disabled={task.busy || task.complete} onChange={(event) => setMargin(Number(event.target.value))} />
        </label>
        <label className="print-ctl">{t.exportScale} ({scale.toFixed(2)}×)
          <input type="range" min={0.5} max={2} step={0.05} value={scale} disabled={task.busy || task.complete} onChange={(event) => setScale(Number(event.target.value))} />
        </label>
        <button className="btn btn-primary" disabled={!ready || task.busy} onClick={() => {
          const frame = frameRef.current?.contentWindow;
          if (!ready || !frame || task.isRunning()) return;
          try { frame.focus(); frame.print(); setPrintError(false); } catch { setPrintError(true); }
        }}>{t.printButton}</button>
        <button className="btn" disabled={!ready || task.busy || task.complete} onClick={() => {
          if (ready && result) void task.run(() => onExport("pdf", options, snapshot, result.html));
        }}>PDF</button>
        <button className="btn btn-plain" disabled={task.busy} onClick={cancel}>{task.complete ? t.done : t.cancel}</button>
      </div>
      <p className="print-hint">{t.printPreviewHint}</p>
      <ExportFeedback busy={task.busy} result={task.result} t={t} onReveal={onReveal} />
      {printError && <p className="print-error" role="alert">{t.printUnavailable}</p>}
      {error ? <div className="print-error" role="alert">
        <p>{t.previewFailed}: {error}</p><button className="btn" onClick={retryRender}>{t.wsRetry}</button>
      </div> : !ready && <div className="print-status" role="status">{t.loading}</div>}
      <div className="print-preview-scroll" aria-busy={!ready && !error}>
        {result && <iframe key={result.version} ref={frameRef} className="print-page" title={t.printPreviewTitle} tabIndex={0}
          style={{ width: width + "mm", visibility: result.request === request && !error ? "visible" : "hidden" }}
          srcDoc={result.html} sandbox="allow-same-origin allow-modals" referrerPolicy="no-referrer"
          onLoad={(event) => {
            frameCleanup.current?.(); frameCleanup.current = null;
            const frame = event.currentTarget;
            if (currentRequest.current !== result.request) return;
            frameCleanup.current = connectPrintFrame(frame, scroll,
              () => { if (currentRequest.current === result.request) setLoaded(result.request); },
              () => { if (currentRequest.current === result.request) setError(t.previewFailed); });
          }} />}
      </div>
    </div>
  </div>;
}
