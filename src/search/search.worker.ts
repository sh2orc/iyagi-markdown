import { performSearchTask, SearchWorkError, type SearchRequest, type SearchResponse } from "./searchWork";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null;
  postMessage: (response: SearchResponse) => void;
};
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ id: data.id, ok: true, result: performSearchTask(data) }); }
  catch (error) {
    scope.postMessage({ id: data.id, ok: false, error: error instanceof SearchWorkError ? error.code : "failed" });
  }
};
