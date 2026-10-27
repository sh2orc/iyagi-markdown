// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { asyncEditPlugin, captureAsyncEdit } from "./asyncEdit";
import { cutTextToClipboard, pasteTextFromClipboard, setClipboardNoticeHandler } from "./clipboard";

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const views: EditorView[] = [];
function makeView(doc = "selected text") {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({ parent: host, state: EditorState.create({
    doc, selection: { anchor: 0, head: 8 }, extensions: [asyncEditPlugin, history()],
  }) });
  views.push(view);
  return view;
}
function clipboard(value: { readText?: () => Promise<string>; writeText?: (text: string) => Promise<void> }) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}
async function settle() { for (let n = 0; n < 5; n++) await Promise.resolve(); }
afterEach(() => {
  for (const view of views.splice(0)) { const host = view.dom.parentElement; view.destroy(); host?.remove(); }
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  setClipboardNoticeHandler(null);
});

describe("asynchronous clipboard edits", () => {
  it("uses normalized CRLF length for the replacement cursor", () => {
    const view = makeView("selected");
    const target = captureAsyncEdit(view, "clipboard-read")!;
    expect(target.replace("a\r\nb", "input.pastePlain")).toBe(true);
    expect(view.state.doc.toString()).toBe("a\nb");
    expect(view.state.selection.main.head).toBe(3);
  });

  it("maps the captured range through unrelated typing without moving the new cursor", async () => {
    const view = makeView();
    let resolve!: (text: string) => void;
    clipboard({ readText: () => new Promise((done) => { resolve = done; }) });
    pasteTextFromClipboard(view);
    view.dispatch({ changes: { from: 0, insert: "prefix " }, selection: { anchor: 0 } });
    resolve("PASTE");
    await settle();
    expect(view.state.doc.toString()).toBe("prefix PASTE text");
    expect(view.state.selection.main.head).toBe(0);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("prefix selected text");
  });

  it.each(["tab", "overlap", "lock", "destroy"])("does not paste after %s", async (change) => {
    const view = makeView();
    let resolve!: (text: string) => void;
    clipboard({ readText: () => new Promise((done) => { resolve = done; }) });
    pasteTextFromClipboard(view);
    if (change === "tab") view.setState(EditorState.create({ doc: "selected text", extensions: [asyncEditPlugin] }));
    else if (change === "overlap") view.dispatch({ changes: { from: 1, to: 2, insert: "!" } });
    else if (change === "lock") view.setState(EditorState.create({
      doc: view.state.doc, extensions: [asyncEditPlugin, EditorState.readOnly.of(true)],
    }));
    else view.destroy();
    const expected = view.state.doc.toString();
    resolve("must not appear");
    await settle();
    expect(view.state.doc.toString()).toBe(expected);
  });

  it("keeps the newest read when promises finish out of order", async () => {
    const view = makeView();
    const resolve: Array<(text: string) => void> = [];
    clipboard({ readText: () => new Promise((done) => { resolve.push(done); }) });
    pasteTextFromClipboard(view);
    pasteTextFromClipboard(view);
    resolve[1]("new");
    await settle();
    resolve[0]("old");
    await settle();
    expect(view.state.doc.toString()).toBe("new text");
  });

  it("keeps the original text when clipboard write fails", async () => {
    const view = makeView();
    const notice = vi.fn();
    setClipboardNoticeHandler(notice);
    clipboard({ writeText: async () => { throw new Error("Denied"); } });
    cutTextToClipboard(view);
    await settle();
    expect(view.state.doc.toString()).toBe("selected text");
    expect(notice).toHaveBeenCalled();
  });

  it("cuts only after copying succeeds and preserves intervening edits", async () => {
    const view = makeView();
    let resolve!: () => void;
    const writeText = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    clipboard({ writeText });
    cutTextToClipboard(view);
    expect(writeText).toHaveBeenCalledWith("selected");
    expect(view.state.doc.toString()).toBe("selected text");
    view.dispatch({ changes: { from: 0, insert: "prefix " }, selection: { anchor: 0 } });
    resolve();
    await settle();
    expect(view.state.doc.toString()).toBe("prefix  text");
    expect(view.state.selection.main.head).toBe(0);
    undo(view);
    expect(view.state.doc.toString()).toBe("prefix selected text");
  });

  it("does not delete content that changed while the clipboard write was pending", async () => {
    const view = makeView();
    let resolve!: () => void;
    clipboard({ writeText: () => new Promise<void>((done) => { resolve = done; }) });
    cutTextToClipboard(view);
    view.dispatch({ changes: { from: 0, to: 8, insert: "replacement" } });
    resolve();
    await settle();
    expect(view.state.doc.toString()).toBe("replacement text");
  });

  it("invalidates deferred HTML replacements across identical document states", () => {
    const view = makeView();
    const original = view.state;
    const target = captureAsyncEdit(view, "html-upgrade", { from: 0, to: 8 })!;
    view.setState(EditorState.create({ doc: "selected text", extensions: [asyncEditPlugin] }));
    view.setState(original);
    expect(target.replace("**selected**", "input.pasteHtmlUpgrade")).toBe(false);
    expect(view.state.doc.toString()).toBe("selected text");
  });

  it("maps a deferred HTML replacement without consuming adjacent input", () => {
    const view = makeView();
    const target = captureAsyncEdit(view, "html-upgrade", { from: 0, to: 8 })!;
    view.dispatch({ changes: [{ from: 0, insert: "before " }, { from: 8, insert: " after" }], selection: { anchor: 0 } });
    expect(target.replace("**selected**", "input.pasteHtmlUpgrade")).toBe(true);
    expect(view.state.doc.toString()).toBe("before **selected** after text");
  });
});
