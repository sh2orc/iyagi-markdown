import type { AppStore } from "./store";

/** If closing fails after Discard, the still-open buffers need recovery again. */
export function restoreUnclosedDrafts(store: AppStore, ids: readonly string[]): void {
  const discarded = store.state.tabs.filter((tab) => ids.includes(tab.id) && !tab.dirty && tab.state.doc.toString() !== tab.savedText);
  if (discarded.length) store.restoreDiscardedDocuments(discarded.map((tab) => tab.id));
}

/** A close approval belongs to the reviewed document set, not just dirty flags. */
export function closingDocumentsUnchanged(store: AppStore): () => boolean {
  store.syncActiveState();
  const snapshot = store.state.tabs.map((tab) => ({
    id: tab.id, path: tab.path, doc: tab.state.doc, style: tab.docStyle,
    dirty: tab.dirty, savedText: tab.savedText,
  }));
  return () => snapshot.length === store.state.tabs.length && snapshot.every((saved, index) => {
    const tab = store.state.tabs[index];
    return saved.id === tab.id && saved.path === tab.path && saved.doc === tab.state.doc &&
      saved.style === tab.docStyle && saved.dirty === tab.dirty && saved.savedText === tab.savedText;
  });
}
