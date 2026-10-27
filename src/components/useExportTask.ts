import { useEffect, useRef, useState } from "react";
import type { ExportResult } from "../export/result";

/** Keep the reviewed UI alive for cancellation/retry; lock synchronously, before React paints. */
export function useExportTask() {
  const mounted = useRef(true), running = useRef(false), completed = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (action: () => Promise<ExportResult>): Promise<void> => {
    if (running.current || completed.current) return;
    running.current = true; setBusy(true); setResult(null);
    try {
      const outcome = await action();
      if (outcome.status === "saved") completed.current = true;
      if (mounted.current) setResult(outcome);
    } catch (error) {
      if (mounted.current) setResult({ status: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, result, run, isRunning: () => running.current, complete: result?.status === "saved" };
}
