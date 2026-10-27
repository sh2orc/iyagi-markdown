// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { DEFAULT_DOC_STYLE } from "../app/docStyle";
import { captureExportSnapshot } from "./snapshot";

function fixture() {
  const raw = "---\ntitle: Original\nauthor: Writer\n---\n# Title\n\n[[Other]]\n";
  const tab: Parameters<typeof captureExportSnapshot>[0] = {
    state: EditorState.create({ doc: raw }),
    path: "/docs/note.md",
    title: "note.md",
    savedText: raw,
    docStyle: {
      ...DEFAULT_DOC_STYLE, font: "serif", fontSize: 14, highlightColor: "AABBCC",
      imageWidths: { "image.png": 50 }, tableWidths: { table: [120, 240] },
    },
    comments: [{ id: 1, lineNo: 7, text: "original comment", resolved: false, createdAt: 1 }],
  };
  const context: Parameters<typeof captureExportSnapshot>[1] = {
    workspace: "/docs", theme: "dark", pageNumbers: true, header: true,
    wikiIndex: new Map([["other", ["/docs/Other.md"]]]),
  };
  return { tab, context };
}

describe("export input snapshot", () => {
  it("keeps body, paths, nested styles, comments and settings from the same moment", async () => {
    const { tab, context } = fixture();
    const snapshot = captureExportSnapshot(tab, context, true);
    // Simulate changes delivered while a native picker or renderer is pending.
    await Promise.resolve();
    tab.state = EditorState.create({ doc: "# Replacement" });
    tab.path = "/moved/note.md";
    tab.docStyle!.font = "mono";
    tab.docStyle!.imageWidths["image.png"] = 100;
    tab.docStyle!.tableWidths.table[0] = 999;
    tab.comments[0].text = "new comment";
    tab.comments[0].lineNo = 1;
    context.workspace = "/moved";
    context.theme = "light";
    context.pageNumbers = false;
    context.header = false;
    context.wikiIndex.get("other")![0] = "/moved/Other.md";
    context.wikiIndex.clear();

    expect(snapshot.text).toContain("# Title");
    expect(snapshot.text).not.toContain("Replacement");
    expect(snapshot.baseDir).toBe("/docs");
    expect(snapshot.wikiResolve("Other")).toBe("/docs/Other.md");
    expect(snapshot.style.font).toBe("serif");
    expect(snapshot.imageWidths).toEqual({ "image.png": 50 });
    expect(snapshot.tableWidths).toEqual({ table: [120, 240] });
    expect(snapshot.comments).toEqual([[3, "original comment"]]);
    expect(snapshot.theme).toBe("dark");
    expect(snapshot.pageNumbers).toBe(true);
    expect(snapshot.header).toBe(true);
    expect(snapshot.metaTitle).toBe("Original");
    expect(snapshot.metaAuthor).toBe("Writer");
    expect(snapshot.markdown).toContain("---\ntitle: Original\nauthor: Writer\n---\n");
    expect(snapshot.markdown).not.toContain("[[Other]]");
  });

  it("uses current-buffer comment lines before removing frontmatter and excludes deleted anchors", () => {
    const { tab, context } = fixture();
    tab.savedText = "---\ntitle: T\n---\nKeep\nRemove\nEnd";
    tab.state = EditorState.create({ doc: "---\ntitle: T\n---\nInserted\nKeep\nEnd" });
    tab.comments = [
      { id: 1, lineNo: 4, text: "kept", resolved: false, createdAt: 1 },
      { id: 2, lineNo: 5, text: "deleted", resolved: false, createdAt: 1 },
      { id: 3, lineNo: 6, text: "resolved", resolved: true, createdAt: 1 },
      { id: 4, lineNo: 2, text: "metadata", resolved: false, createdAt: 1 },
    ];
    expect(captureExportSnapshot(tab, context, true).comments).toEqual([[2, "kept"]]);
    expect(captureExportSnapshot(tab, context).comments).toEqual([]);
  });

  it("maps the selected highlight to the backend DOCX field", () => {
    const { tab, context } = fixture();
    const snapshot = captureExportSnapshot(tab, context);
    expect(snapshot.docxStyle).toMatchObject({ font: "serif", sizePt: 14, highlight: "AABBCC", pageNumbers: true });
    expect(snapshot.docxStyle).not.toHaveProperty("highlightColor");
  });

  it("retains the workspace for an untitled document after the workspace changes", () => {
    const { tab, context } = fixture();
    tab.path = null;
    tab.state = EditorState.create({ doc: "Text" });
    const snapshot = captureExportSnapshot(tab, context);
    context.workspace = "/elsewhere";
    expect(snapshot.baseDir).toBe("/docs");
    expect(snapshot.name).toBe("untitled");
  });
});
