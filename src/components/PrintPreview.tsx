// 인쇄 미리보기(⌘P) — 내보내기 파이프라인(§4-4)으로 만든 자체 완결형 HTML을
// 모달 안에 렌더한다. 저장은 기존 PDF 내보내기 버튼으로.

import { useEffect, useState } from "react";

import { api } from "../api";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import type { PdfOptions } from "./ExportSheet";

interface Props {
  store: AppStore;
  t: Translate;
  onExport: (kind: "pdf", opts: PdfOptions) => void;
  onCancel: () => void;
}

export function PrintPreview({ store, t, onExport, onCancel }: Props): JSX.Element | null {
  const tab = store.active;
  const [html, setHtml] = useState<string | null>(null);
  const [paper, setPaper] = useState<"a4" | "letter" | "a5">("a4");

  useEffect(() => {
    if (!tab) return;
    let alive = true;
    const text = tab.state.doc.toString();
    const name = tab.path ? tab.title.replace(/\.(md|markdown)$/i, "") : "untitled";
    void (async () => {
      // markdown-it은 여기서만 필요 — 동적 로드로 메인 청크를 가볍게 유지.
      const { buildExportHtml } = await import("../export/html");
      const built = await buildExportHtml(text, {
        title: tab.path ? tab.title : name,
        baseDir: tab.path ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/" : store.state.workspace ?? "",
        theme: store.state.theme,
        forPdf: true,
        marginMm: 14,
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
  }, [tab, tab?.state.doc, store]);

  if (!tab) return null;

  return (
    <div className="overlay print-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
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
          <button className="btn btn-primary" onClick={() => onExport("pdf", { paper, orientation: "portrait", marginMm: 14, scale: 1 })}>
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
