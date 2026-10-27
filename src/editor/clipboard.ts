import type { EditorView } from "@codemirror/view";
import { phrases } from "../app/phrases";
import { captureAsyncEdit } from "./asyncEdit";

let noticeHandler: ((text: string, kind: "info" | "error") => void) | null = null;
export function setClipboardNoticeHandler(handler: typeof noticeHandler): void { noticeHandler = handler; }
export function clipboardNotice(text: string, kind: "info" | "error" = "error"): void {
  noticeHandler?.(text, kind);
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    clipboardNotice(phrases.clipboardWriteFailed);
    return false;
  }
}

export function pasteTextFromClipboard(view: EditorView): boolean {
  const target = captureAsyncEdit(view, "clipboard-read");
  if (!target) return false;
  void (async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      if (!target.replace(text, "input.pastePlain")) clipboardNotice(phrases.clipboardTargetChanged, "info");
    } catch {
      if (target.current()) clipboardNotice(phrases.clipboardReadFailed);
    } finally { target.finish(); }
  })();
  return true;
}

export function cutTextToClipboard(view: EditorView): boolean {
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  const target = captureAsyncEdit(view, "clipboard-cut");
  if (!target) return false;
  const text = view.state.sliceDoc(sel.from, sel.to);
  void (async () => {
    try {
      if (await copyTextToClipboard(text)) {
        if (!target.replace("", "delete.cut")) clipboardNotice(phrases.clipboardTargetChanged, "info");
      }
    } finally { target.finish(); }
  })();
  return true;
}
