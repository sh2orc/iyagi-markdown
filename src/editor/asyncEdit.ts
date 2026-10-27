import { type ChangeDesc } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

export interface PendingRange { from: number; to: number; invalid: boolean }

/** Preserve an insertion point through unrelated edits; never replace edited content. */
export function mapPendingRange(range: PendingRange, changes: ChangeDesc): void {
  if (range.invalid || changes.empty) return;
  changes.iterChangedRanges((from, to) => {
    const overlaps = range.from === range.to
      ? from <= range.from && to > range.from
      : (from < range.to && to > range.from) || (from === to && from > range.from && from < range.to);
    if (overlaps) range.invalid = true;
  });
  const empty = range.from === range.to;
  range.from = changes.mapPos(range.from, 1);
  range.to = empty ? range.from : changes.mapPos(range.to, -1);
}

export const asyncEditPlugin = ViewPlugin.fromClass(class {
  pending = new Map<string, PendingRange>();
  update(update: ViewUpdate) {
    for (const range of this.pending.values()) {
      if (update.state.readOnly) range.invalid = true;
      else mapPendingRange(range, update.changes);
    }
  }
  destroy() {
    for (const range of this.pending.values()) range.invalid = true;
    this.pending.clear();
  }
});

/** ViewPlugin lifetime ends on setState, even if the next tab has identical text. */
export function captureAsyncEdit(view: EditorView, key: string, bounds: { from: number; to: number } = view.state.selection.main) {
  const plugin = view.plugin(asyncEditPlugin);
  if (!plugin || view.state.readOnly || !view.dom.isConnected) return null;
  const previous = plugin.pending.get(key);
  if (previous) previous.invalid = true;
  const range: PendingRange = { from: bounds.from, to: bounds.to, invalid: false };
  let revision = 0;
  plugin.pending.set(key, range);
  const current = () => !range.invalid && view.dom.isConnected && !view.state.readOnly &&
    view.plugin(asyncEditPlugin) === plugin && plugin.pending.get(key) === range;
  const finish = () => {
    revision++;
    range.invalid = true;
    if (plugin.pending.get(key) === range) plugin.pending.delete(key);
  };
  return {
    current, finish,
    /** continueAtEnd keeps a successful insertion session at its new endpoint;
     * callers must still finish it when their picker closes. Default: one edit. */
    replace(text: string, userEvent: string, options: { continueAtEnd?: boolean } = {}): boolean {
      if (!current()) { finish(); return false; }
      const sel = view.state.selection.main;
      const atTarget = sel.from === range.from && sel.to === range.to;
      const { from, to } = range;
      const expected = view.state.changes({ from, to, insert: text }).apply(view.state.doc);
      const insertionEnd = to + expected.length - view.state.doc.length;
      finish();
      const finishedAt = revision;
      view.dispatch({
        changes: { from, to, insert: text },
        ...(atTarget ? { selection: { anchor: insertionEnd } } : {}),
        annotations: isolateHistory.of("full"), userEvent,
      });
      const applied = view.state.doc.eq(expected);
      // A symbol picker may insert repeatedly at this endpoint, even when the
      // editor selection moved elsewhere. Never revive a cancelled/replaced
      // session or transfer it to a new state installed during dispatch.
      if (applied && options.continueAtEnd && revision === finishedAt &&
          view.plugin(asyncEditPlugin) === plugin && !plugin.pending.has(key) &&
          view.dom.isConnected && !view.state.readOnly) {
        range.from = range.to = insertionEnd;
        range.invalid = false;
        plugin.pending.set(key, range);
      }
      return applied;
    },
  };
}
