import type { ExportHtmlOptions } from "./html";
import type { ExportSnapshot } from "./snapshot";

export interface PdfOptions {
  paper: "a4" | "letter" | "a5";
  orientation: "portrait" | "landscape";
  marginMm: number;
  scale: number;
}

export function paperDimensions(options: Pick<PdfOptions, "paper" | "orientation">): [number, number] {
  const size: [number, number] = options.paper === "letter" ? [215.9, 279.4]
    : options.paper === "a5" ? [148, 210] : [210, 297];
  return options.orientation === "landscape" ? [size[1], size[0]] : size;
}

/** Shared by print preview and the PDF writer; no mutable tab is read after capture. */
export function snapshotHtmlOptions(snapshot: ExportSnapshot, readBytes: ExportHtmlOptions["readBytes"], pdf?: PdfOptions): ExportHtmlOptions {
  return {
    title: snapshot.docTitle, baseDir: snapshot.baseDir, theme: pdf ? "light" : snapshot.theme,
    style: snapshot.style, imageWidths: snapshot.imageWidths, tableWidths: snapshot.tableWidths,
    frontLists: { toc: !!snapshot.fm?.toc, lof: !!snapshot.fm?.lof, lot: !!snapshot.fm?.lot },
    lang: snapshot.lang, readBytes, wikiResolve: snapshot.wikiResolve,
    ...(pdf ? { forPdf: true, paper: pdf.paper, orientation: pdf.orientation,
      marginMm: pdf.marginMm, scale: pdf.scale, pageNumbers: snapshot.pageNumbers,
      pdfHeader: snapshot.fm?.header ?? (snapshot.header ? snapshot.docTitle : null),
      pdfFooter: snapshot.fm?.footer ?? null } : {}),
  };
}

/** One body per mounted preview. Slider changes reuse it, while reopening a preview
 * reads assets again. Never shares theme-dependent diagrams between source and print. */
export function createPreviewRenderer() {
  let cached: { snapshot: ExportSnapshot; theme: ExportHtmlOptions["theme"]; body: Promise<string> } | null = null;
  // 모듈 해석은 렌더러 수명당 한 번 — 매 렌더의 import() 재조회를 줄이고
  // 나란히 시작한 두 렌더가 서로 다른 해석(테스트 목·실제)으로 갈라지지
  // 않게 확정한다.
  let mod: typeof import("./html") | null = null;
  return async (snapshot: ExportSnapshot, options: ExportHtmlOptions): Promise<string> => {
    mod ??= await import("./html");
    const { renderExportBody, buildExportHtml } = mod;
    let entry = cached;
    if (!entry || entry.snapshot !== snapshot || entry.theme !== options.theme) {
      entry = { snapshot, theme: options.theme, body: renderExportBody(snapshot.markdown, options) };
      cached = entry;
      void entry.body.catch(() => { if (cached === entry) cached = null; });
    }
    const body = await entry.body;
    return buildExportHtml(snapshot.markdown, { ...options, preRendered: body });
  };
}
