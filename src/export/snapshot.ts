import type { Tab } from "../app/store";
import type { DocxManifest } from "../api";
import type { ExportHtmlOptions } from "./html";
import { frontMatterLen, frontMatterMeta, stripFrontMatter } from "../editor/frontmatter";
import { normalizeUnderlineRules } from "../links";
import { inlineEmbeds, resolveWikiLink, wikiLinksToMarkdown } from "../editor/wiki";
import { shiftLineNumbers } from "../editor/trackChanges";

interface ExportContext {
  workspace: string | null;
  theme: "light" | "dark";
  pageNumbers: boolean;
  header: boolean;
  wikiIndex: Map<string, string[]>;
  lang?: "ko" | "en";
}

/** Capture all mutable document inputs before a picker, renderer or IPC can yield. */
export function captureExportSnapshot(
  tab: Pick<Tab, "state" | "path" | "title" | "docStyle" | "comments" | "savedText">,
  context: ExportContext,
  includeComments = false,
) {
  const raw = tab.state.doc.toString();
  const baseDir = tab.path
    ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/"
    : context.workspace ?? "";
  const wikiIndex = new Map([...context.wikiIndex].map(([name, paths]) => [name, [...paths]]));
  const wikiResolve = (name: string) => resolveWikiLink(name, baseDir, wikiIndex);
  // setext 정규화(2026-10-24) — 밑줄형 제목 짝에 빈 줄을 넣어 에디터 뷰와
  // comrak 내보내기가 일치하게(붙여넣기·오래된 문서 경로 흡수). 코멘트
  // 줄번호는 insertLines로 보정한다.
  const norm = normalizeUnderlineRules(wikiLinksToMarkdown(stripFrontMatter(raw), wikiResolve, baseDir));
  const text = norm.text;
  const markdown = raw.slice(0, frontMatterLen(raw)) + text;
  const fm = frontMatterMeta(raw);
  const metaTitle = fm?.title ?? "";
  const metaAuthor = fm?.author ?? "";
  const name = (metaTitle || (tab.path ? tab.title : "untitled"))
    .replace(/\.(md|markdown)$/i, "")
    .replace(/[\/:*?"<>|]/g, "-") || "untitled";
  const docTitle = metaTitle || (tab.path ? tab.title : name);
  const ds = tab.docStyle;
  const style: NonNullable<ExportHtmlOptions["style"]> = {
    font: ds?.font ?? "system",
    sizePt: ds && ds.fontSize > 0 ? ds.fontSize : 11,
    lineHeight: ds?.lineHeight ?? 0,
    firstLineIndent: ds?.firstLineIndent ?? false,
    textAlign: ds?.textAlign ?? "left",
    accent: ds?.accent ?? null,
    highlightColor: ds?.highlightColor ?? null,
  };
  const imageWidths = { ...ds?.imageWidths };
  const { highlightColor, ...commonStyle } = style;
  const docxStyle: NonNullable<DocxManifest["style"]> = {
    ...commonStyle, highlight: highlightColor, pageNumbers: context.pageNumbers,
  };
  const tableWidths = Object.fromEntries(
    Object.entries(ds?.tableWidths ?? {}).map(([key, widths]) => [key, [...widths]]),
  );
  const comments: Array<[number, string]> = [];
  if (includeComments) {
    const unresolved = tab.comments.filter((comment) => !comment.resolved);
    const lines = shiftLineNumbers(unresolved.map((comment) => comment.lineNo), tab.savedText, raw);
    const prefix = frontMatterLen(raw);
    const prefixLines = prefix ? raw.slice(0, prefix).split("\n").length - 1 : 0;
    for (const [index, comment] of unresolved.entries()) {
      const body = lines[index] - prefixLines;
      const line = body + norm.insertLines.filter((l) => l <= body).length;
      if (line > 0) comments.push([line, comment.text]);
    }
  }
  return {
    text, markdown, baseDir, wikiResolve, fm, metaTitle, metaAuthor, name, docTitle,
    style, docxStyle, imageWidths, tableWidths, comments,
    theme: context.theme, pageNumbers: context.pageNumbers, header: context.header, lang: context.lang ?? "ko",
  };
}

export type ExportSnapshot = ReturnType<typeof captureExportSnapshot>;

/** 내보내기 직전 임베드 ![[이름]] 인라인 — 모든 형식이 같은 마크다운을
 *  쓰므로 이 한 곳에서 끝낸다. 문서 메모가 있으면 줄번호가 밀리므로 건너뛴다. */
export async function applyEmbeds(
  snapshot: ExportSnapshot,
  read: (path: string) => Promise<string | null>,
): Promise<ExportSnapshot> {
  if (!/!\[\[/.test(snapshot.markdown)) return snapshot;
  if (snapshot.comments.length > 0) return snapshot;
  const inlined = await inlineEmbeds(snapshot.markdown, snapshot.wikiResolve, read);
  if (inlined === snapshot.markdown) return snapshot;
  return { ...snapshot, markdown: inlined, text: stripFrontMatter(inlined) };
}
