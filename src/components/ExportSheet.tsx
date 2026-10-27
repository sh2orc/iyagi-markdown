// 내보내기 시트(§4-4) — 형식 확인·PDF 옵션 → 저장 대화상자는 App이 띄운다.

import { useState } from "react";

import type { ExportKind } from "../app/store";
import type { Translate } from "../i18n";
import type { PdfOptions } from "../export/preview";
import type { ExportSnapshot } from "../export/snapshot";
import type { ExportResult } from "../export/result";
import { imeComposing } from "../app/ime";
import { useExportTask } from "./useExportTask";
import { ExportFeedback } from "./ExportFeedback";
export type { PdfOptions } from "../export/preview";

interface Props {
  kind: ExportKind;
  t: Translate;
  capture: () => ExportSnapshot | null;
  onRun: (kind: ExportKind, opts: PdfOptions, snapshot: ExportSnapshot) => Promise<ExportResult>;
  onReveal?: (path: string) => Promise<void>;
  onCancel: () => void;
  pageNumbers?: boolean;
  onTogglePageNumbers?: (v: boolean) => void;
  /** PDF 머리글(문서 제목) 표시 — pdfKind에서만 노출. */
  pdfHeader?: boolean;
  onTogglePdfHeader?: (v: boolean) => void;
  /** 마지막 내보내기 옵션(설정에서 복원). */
  saved?: { paper: "a4" | "letter" | "a5"; landscape: boolean; margin: number; scale: number };
}

export function ExportSheet({ kind, t, capture, onRun, onReveal, onCancel, pageNumbers = true, onTogglePageNumbers, pdfHeader = true, onTogglePdfHeader, saved }: Props): JSX.Element {
  const [snapshot] = useState(capture);
  const task = useExportTask();
  const cancel = () => { if (!task.isRunning()) onCancel(); };
  // 마지막 내보내기 옵션 복원 — App이 실행 시 설정에 저장해 전달한다.
  const [paper, setPaper] = useState<"a4" | "letter" | "a5">(saved?.paper ?? "a4");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(saved?.landscape ? "landscape" : "portrait");
  const [margin, setMargin] = useState(saved?.margin ?? 14);
  const [scale, setScale] = useState(saved?.scale ?? 1);

  const label =
    kind === "html"
      ? t.exportHtml
      : kind === "pdf"
        ? t.exportPdf
        : kind === "epub"
          ? t.exportEpub
          : t.exportDocx;

  return (
    <div className="overlay modal-overlay" role="dialog" aria-modal="true" aria-label={`${t.exportTitle} — ${label}`}
      aria-busy={task.busy} onClick={(e) => e.target === e.currentTarget && cancel()}
      onKeyDown={(e) => {
        if (imeComposing(e)) return;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
      }}>
      <div className="modal export-modal">
        <div className="modal-title">{t.exportTitle}</div>
        <div className="modal-kind">{label}</div>
        <p className="export-document">{snapshot?.docTitle ?? t.emptyNoDoc}</p>
        {snapshot && <p className="modal-hint">{t.exportSnapshotHint}</p>}
        <fieldset className="export-fields" disabled={task.busy || task.complete}>
        {kind === "pdf" && (
          <div className="export-options">
            <label>
              {t.exportPaper}
              <select value={paper} onChange={(e) => setPaper(e.target.value as "a4" | "letter" | "a5")}>
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
                <option value="a5">A5</option>
              </select>
            </label>
            <label>
              {t.exportOrientation}
              <select
                value={orientation}
                onChange={(e) => setOrientation(e.target.value as "portrait" | "landscape")}
              >
                <option value="portrait">{t.exportPortrait}</option>
                <option value="landscape">{t.exportLandscape}</option>
              </select>
            </label>
            <label>
              {t.exportMargin} ({margin}mm)
              <input
                type="range"
                min={0}
                max={30}
                value={margin}
                onChange={(e) => setMargin(Number(e.target.value))}
              />
            </label>
            <label>
              {t.exportScale} ({scale.toFixed(2)}×)
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={scale}
                onChange={(e) => setScale(Number(e.target.value))}
              />
            </label>
            {onTogglePageNumbers && (
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={pageNumbers}
                  onChange={(e) => onTogglePageNumbers(e.target.checked)}
                />
                {t.exportPageNumbers}
              </label>
            )}
            {onTogglePdfHeader && (
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={pdfHeader}
                  onChange={(e) => onTogglePdfHeader(e.target.checked)}
                />
                {t.exportPdfHeader}
              </label>
            )}
          </div>
        )}
        {kind === "docx" && (
          <div className="export-options">
            {onTogglePageNumbers && (
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={pageNumbers}
                  onChange={(e) => onTogglePageNumbers(e.target.checked)}
                />
                  {t.exportPageNumbers}
              </label>
            )}
            {onTogglePdfHeader && (
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={pdfHeader}
                  onChange={(e) => onTogglePdfHeader(e.target.checked)}
                />
                {t.exportPdfHeader}
              </label>
            )}
          </div>
        )}
        </fieldset>
        <p className="modal-hint">{t.exportVectorHint}</p>
        <ExportFeedback busy={task.busy} result={task.result} t={t} onReveal={onReveal} />
        <div className="modal-actions">
          <button
            className="btn btn-primary"
            disabled={!snapshot || task.busy || task.complete}
            onClick={() => {
              if (!snapshot) return;
              void task.run(() => onRun(kind, { paper, orientation, marginMm: margin, scale }, {
                ...snapshot, pageNumbers, header: pdfHeader, docxStyle: { ...snapshot.docxStyle, pageNumbers },
              }));
            }}
          >
            {/* 실행 버튼 — 시트 제목(…로 열림)과 달리 동사로: 마지막 확인 단계임을 분명히. */}
            {t.exportRun} {label}
          </button>
          <button className="btn btn-plain" disabled={task.busy} onClick={cancel}>
            {task.complete ? t.done : t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
