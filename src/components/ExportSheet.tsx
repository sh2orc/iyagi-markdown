// 내보내기 시트(§4-4) — 형식 확인·PDF 옵션 → 저장 대화상자는 App이 띄운다.

import { useState } from "react";

import type { ExportKind } from "../app/store";
import type { Translate } from "../i18n";

interface Props {
  kind: ExportKind;
  t: Translate;
  onRun: (kind: ExportKind, opts: PdfOptions) => void;
  onCancel: () => void;
}

export interface PdfOptions {
  paper: "a4" | "letter" | "a5";
  orientation: "portrait" | "landscape";
  marginMm: number;
  scale: number;
}

export function ExportSheet({ kind, t, onRun, onCancel }: Props): JSX.Element {
  const [paper, setPaper] = useState<"a4" | "letter" | "a5">("a4");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("portrait");
  const [margin, setMargin] = useState(14);
  const [scale, setScale] = useState(1);

  const label =
    kind === "html" ? t.exportHtml : kind === "pdf" ? t.exportPdf : t.exportDocx;

  return (
    <div className="overlay modal-overlay" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <div className="modal-title">{t.exportTitle}</div>
        <div className="modal-kind">{label}</div>
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
          </div>
        )}
        <p className="modal-hint">HTML·PDF·DOCX — 모두 벡터(편집 가능 객체)로 내보낸다.</p>
        <div className="modal-actions">
          <button
            className="btn btn-primary"
            onClick={() => onRun(kind, { paper, orientation, marginMm: margin, scale })}
          >
            {t.exportTitle}
          </button>
          <button className="btn btn-plain" onClick={onCancel}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
