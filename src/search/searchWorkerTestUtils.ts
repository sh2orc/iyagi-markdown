import { performSearchTask, SearchWorkError, type SearchRequest, type SearchResponse } from "./searchWork";
import type { SearchWorkerPort } from "./searchWorkerClient";

/** In-process test double only. Production never falls back to the main thread. */
export class InlineSearchWorker implements SearchWorkerPort {
  onmessage: SearchWorkerPort["onmessage"] = null;
  onerror: SearchWorkerPort["onerror"] = null;
  onmessageerror: SearchWorkerPort["onmessageerror"] = null;
  private stopped = false;
  postMessage(request: SearchRequest) {
    void Promise.resolve().then(() => {
      if (this.stopped) return;
      let response: SearchResponse;
      try { response = { id: request.id, ok: true, result: performSearchTask(request) }; }
      catch (error) { response = { id: request.id, ok: false, error: error instanceof SearchWorkError ? error.code : "failed" }; }
      this.onmessage?.(new MessageEvent("message", { data: response }));
    });
  }
  terminate() { this.stopped = true; }
}
