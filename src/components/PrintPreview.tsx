// 인쇄 미리보기(⌘P) — 내보내기 파이프라인(§4-4)으로 만든 자체 완결형 HTML을
// 모달 안에 렌더한다. 저장은 기존 PDF 내보내기 버튼으로.

import { useEffect, useState } from "react";

import { api } from "../api";
import { resolveWikiLink } from "../editor/wiki";
import type { AppStore } from "../app/store";
import { frontMatterMeta } from "../editor/frontmatter";
import type { Translate } from "../i18n";
import type { PdfOptions } from "./ExportSheet";

interface Props {
  store: AppStore;
  t: Translate;
  onExport: (kind: "pdf", opts: PdfOptions) => void;
  onCancel: () => void;
  /** 마지막 내보내기 옵션(설정에서 복원). */
  saved?: { paper: "a4" | "letter" | "a5"; margin: number; scale: number };
}

export function PrintPreview({
  store,
  t,
  onExport,
  onCancel,
  saved,
}: Props): JSX.Element | null {
  const tab = store.active;
  const [html, setHtml] = useState<string | null>(null);
  const [paper, setPaper] = useState<"a4" | "letter" | "a5">(saved?.paper ?? "a4");
  const [margin, setMargin] = useState(saved?.margin ?? 14);
  const [scale, setScale] = useState(saved?.scale ?? 1);
  // 옵션(용지·여백·배율) 바뀌면 재렌더 — 연속 조절에 프레임을 태우지
  // 않게 디바운스.
  const [renderKey, setRenderKey] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => setRenderKey((k) => k + 1), 300);
    return () => clearTimeout(id);
  }, [paper, margin, scale]);

  useEffect(() => {
    if (!tab) return;
    let alive = true;
    const text = tab.state.doc.toString();
    const name = tab.path ? tab.title.replace(/\.(md|markdown)$/i, "") : "untitled";
    void (async () => {
      // markdown-it은 여기서만 필요 — 동적 로드로 메인 청크를 가볍게 유지.
      const { buildExportHtml } = await import("../export/html");
      // 프런트매터 메타·사이드카 — 실제 내보내기(App.runExport)와 같은 옵션으로
      // 미리보기=결과를 보장(그동안 목차·이미지 폭이 미리보기에만 빠졌음).
      const fm = frontMatterMeta(text);
      const ds = tab.docStyle;
      const built = await buildExportHtml(text, {
        title: fm?.title || (tab.path ? tab.title : name),
        baseDir: tab.path ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/" : store.state.workspace ?? "",
        theme: store.state.theme,
        forPdf: true,
        marginMm: margin,
        scale,
        imageWidths: ds?.imageWidths ?? {},
        tableWidths: ds?.tableWidths ?? {},
        frontLists: { toc: !!fm?.toc, lof: !!fm?.lof, lot: !!fm?.lot },
        style: {
          font: ds?.font ?? "system",
          sizePt: ds && ds.fontSize > 0 ? ds.fontSize : 11,
          lineHeight: ds?.lineHeight ?? 0,
          firstLineIndent: ds?.firstLineIndent ?? false,
          textAlign: ds?.textAlign ?? "left",
          accent: ds?.accent ?? null,
        },
        wikiResolve: (name) =>
          resolveWikiLink(
            name,
            tab.path ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/" : store.state.workspace ?? "",
            store.wikiIndex,
          ),
        readBytes: async (p) => {
          try {
            return new Uint8Array(await api.readFileBytes(p));
          } catch {
            return null;
          }
        },
      });
      if (alive) setHtml(built);
    })();
    return () => {
      alive = false;
    };
    // margin·scale·renderKey — 옵션 변경 재렌더.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, tab?.state.doc, store, margin, scale, renderKey]);

  if (!tab) return null;

  return (
    <div className="overlay print-overlay" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="print-frame">
        <div className="print-head">
          <span className="print-title">{t.printPreviewTitle}</span>
          <select
            className="print-paper"
            value={paper}
            onChange={(e) => setPaper(e.target.value as "a4" | "letter" | "a5")}
            title={t.exportPaper}
          >
            <option value="a4">A4</option>
            <option value="letter">Letter</option>
            <option value="a5">A5</option>
          </select>
          <label className="print-ctl" title={t.exportMargin}>
            {t.exportMargin} ({margin}mm)
            <input type="range" min={0} max={30} value={margin} onChange={(e) => setMargin(Number(e.target.value))} />
          </label>
          <label className="print-ctl" title={t.exportScale}>
            {t.exportScale} ({scale.toFixed(2)}×)
            <input type="range" min={0.5} max={2} step={0.05} value={scale} onChange={(e) => setScale(Number(e.target.value))} />
          </label>
          <button className="btn btn-primary" onClick={() => onExport("pdf", { paper, orientation: "portrait", marginMm: margin, scale })}>
            PDF
          </button>
          <button className="btn btn-plain" onClick={onCancel}>
            {t.cancel}
          </button>
        </div>
        <p className="print-hint">{t.printPreviewHint}</p>
        {html == null ? (
          <div className="print-loading">
            <div className="spinner" />
          </div>
        ) : (
          <iframe className="print-page" title={t.printPreviewTitle} srcDoc={html} sandbox="" />
        )}
      </div>
    </div>
  );
}
