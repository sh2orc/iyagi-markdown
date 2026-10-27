import { SearchWorkError, type SearchFailure, type SearchRequest, type SearchResponse, type SearchResult, type SearchTask } from "./searchWork";

export interface SearchWorkerPort {
  onmessage: ((event: MessageEvent<SearchResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(request: SearchRequest): void;
  terminate(): void;
}
export const createSearchWorker = (): SearchWorkerPort => new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" });

/** One reusable worker and one active job per editor. Termination can interrupt
 * RegExp.exec even when it never yields to a worker message or an AbortSignal. */
export class SearchWorkerClient {
  private worker: SearchWorkerPort | null = null;
  private sequence = 0;
  private pending: { id: number; kind: SearchTask["kind"]; timer: ReturnType<typeof setTimeout>;
    resolve: (result: SearchResult) => void; reject: (error: SearchWorkError) => void } | null = null;
  constructor(private readonly factory = createSearchWorker) {}

  run(task: SearchTask): Promise<SearchResult> {
    this.cancel();
    return new Promise((resolve, reject) => {
      let worker: SearchWorkerPort;
      try { worker = this.worker ?? this.factory(); } catch { reject(new SearchWorkError("unavailable")); return; }
      this.worker = worker;
      const id = ++this.sequence;
      worker.onmessage = ({ data }) => {
        const pending = this.pending;
        if (this.worker !== worker || !pending || pending.id !== data.id) return;
        if (!data.ok) { this.fail(data.error); return; }
        if (data.result.kind !== pending.kind) { this.fail("failed"); return; }
        clearTimeout(pending.timer); this.pending = null; pending.resolve(data.result);
      };
      worker.onerror = () => { if (this.worker === worker) this.fail("failed"); };
      worker.onmessageerror = () => { if (this.worker === worker) this.fail("failed"); };
      this.pending = { id, kind: task.kind, resolve, reject,
        timer: setTimeout(() => { if (this.pending?.id === id) this.fail("timeout"); }, task.kind === "find" ? 2000 : 5000),
      };
      try { worker.postMessage({ ...task, id }); } catch { this.fail("unavailable"); }
    });
  }
  cancel(): void { if (this.pending) this.fail("cancelled"); }
  dispose(): void { this.cancel(); this.stopWorker(); }
  private stopWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
    this.worker.terminate(); this.worker = null;
  }
  private fail(code: SearchFailure): void {
    const pending = this.pending;
    if (pending) { clearTimeout(pending.timer); this.pending = null; }
    this.stopWorker();
    pending?.reject(new SearchWorkError(code));
  }
}
