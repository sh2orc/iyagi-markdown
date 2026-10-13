// 문서 스타일 패널 — 이 문서만의 폰트·크기·행간·간격·강조색.
// 저장은 SQLite 사이드카(원문 .md는 불변), 변경은 즉시 미리보기에 반영.

import { useState } from "react";

import { api, isInApp, type DocStyle } from "../api";
import type { AppStore } from "../app/store";
import { DEFAULT_DOC_STYLE, STYLE_PRESETS } from "../app/docStyle";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  onClose: () => void;
  t: Translate;
}

/** 형광펜 팔레트 — 문서 톤에 맞춰 고른 5색(Word 형광펜 색 상당). */
const HIGHLIGHT_SWATCHES: Array<[string, string]> = [
  ["FFD60A", "노랑(기본)"],
  ["FFB3C1", "분홍"],
  ["B7F0A8", "연두"],
  ["A8D8FF", "하늘"],
  ["E3C8FF", "라일락"],
];

export function StylePanel({ store, onClose, t }: Props): JSX.Element | null {
  const tab = store.active;
  const [style, setStyle] = useState<DocStyle>(tab?.docStyle ?? DEFAULT_DOC_STYLE);
  if (!tab) return null;

  const update = (patch: Partial<DocStyle>) => {
    const next = { ...style, ...patch };
    setStyle(next);
    store.setDocStyle(next);
  };

  const reset = () => {
    setStyle(DEFAULT_DOC_STYLE);
    store.setDocStyle(DEFAULT_DOC_STYLE);
    if (tab.path && isInApp()) void api.docStyleClear(tab.path).catch(() => {});
  };

  return (
    <div className="overlay modal-overlay" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">
        <div className="modal-title">
          {t.styleTitle}
          <span className="modal-file-name">{tab.path ? tab.title : t.untitled}</span>
        </div>
        <div className="settings-label" style={{ marginBottom: 2 }}>
          {t.stylePresets}
          <div className="style-preset-row">
            {STYLE_PRESETS.map((p) => (
              <button
                key={p.id}
                className="style-preset-card"
                onClick={() => {
                  // 프리셋 적용 — 이미지·표 폭은 그 문서의 기존 배치를 유지.
                  update({
                    ...p.style,
                    imageWidths: style.imageWidths,
                    tableWidths: style.tableWidths,
                  });
                }}
              >
                {/* 미리보기 — 프리셋 값 그대로(폰트·행간·정렬·들여쓰기) */}
                <span
                  className="style-preset-sample"
                  style={{
                    fontFamily:
                      p.style.font === "mono"
                        ? "var(--md-code-font)"
                        : p.style.font === "serif"
                          ? '"New York",Georgia,serif'
                          : p.style.font === "round"
                        ? "ui-rounded,-apple-system,sans-serif"
                        : undefined,
                    fontSize: `${Math.max(10, Math.min(12, p.style.fontSize || 11))}px`,
                    lineHeight: p.style.lineHeight,
                    textAlign: p.style.textAlign === "justify" ? "justify" : p.style.textAlign,
                    textIndent: p.style.firstLineIndent ? "1.2em" : 0,
                  }}
                >
                  {t.styleSampleText}
                </span>
                <span className="style-preset-name">
                  {store.state.settings.language === "ko" ? p.nameKo : p.nameEn}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="settings-grid">
          <label className="settings-label">
            {t.styleFont}
            <div className="style-font-row">
              {(["system", "serif", "round", "mono"] as const).map((f) => (
                <button
                  key={f}
                  className={`style-font-btn ${style.font === f ? "is-on" : ""}`}
                  data-font={f}
                  onClick={() => update({ font: f })}
                >
                  {f === "system" ? t.styleFontSystem : f === "serif" ? t.styleFontSerif : f === "round" ? t.styleFontRound : t.styleFontMono}
                </button>
              ))}
            </div>
          </label>
          <label className="settings-label">
            {t.styleFontSize}{" "}
            <span className="style-value">
              {style.fontSize > 0 ? `${style.fontSize}px` : t.styleGlobal}
            </span>
            <input
              type="range"
              min={0}
              max={26}
              value={style.fontSize}
              onChange={(e) => update({ fontSize: Number(e.target.value) })}
            />
          </label>
          <label className="settings-label">
            {t.styleLineHeight}{" "}
            <span className="style-value">{(style.lineHeight > 0 ? style.lineHeight : 1.55).toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={2.2}
              step={0.05}
              value={style.lineHeight}
              onChange={(e) => update({ lineHeight: Number(e.target.value) })}
            />
          </label>
          <label className="settings-label">
            {t.styleAccent}
            <div className="style-accent-row">
              <input
                type="color"
                value={style.accent ?? "#4f46e5"}
                onChange={(e) => update({ accent: e.target.value })}
              />
              {style.accent && (
                <button className="style-font-btn" onClick={() => update({ accent: null })}>
                  ✕
                </button>
              )}
            </div>
          </label>
          <label className="settings-label">
            {t.styleHighlight}
            <div className="style-accent-row">
              {HIGHLIGHT_SWATCHES.map(([hex, name]) => (
                <button
                  key={hex}
                  className={`style-hl-swatch ${style.highlightColor === hex ? "is-on" : ""}`}
                  title={name}
                  style={{ background: `#${hex}` }}
                  onClick={() => update({ highlightColor: hex })}
                />
              ))}
              {style.highlightColor && (
                <button className="style-font-btn" title={t.styleHlDefault} onClick={() => update({ highlightColor: null })}>
                  ✕
                </button>
              )}
            </div>
          </label>
        </div>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={style.firstLineIndent}
            onChange={(e) => update({ firstLineIndent: e.target.checked })}
          />
          {t.styleIndent}
        </label>
        <label className="settings-label">
          {t.styleAlign}
          <div className="style-font-row">
            {(["left", "center", "right", "justify"] as const).map((a) => (
              <button
                key={a}
                className={`style-font-btn ${style.textAlign === a ? "is-on" : ""}`}
                onClick={() => update({ textAlign: a })}
              >
                {a === "left" ? t.alignLeft : a === "center" ? t.alignCenter : a === "right" ? t.alignRight : t.alignJustify}
              </button>
            ))}
          </div>
        </label>
        <p className="modal-hint">{t.styleStoredHint}</p>
        <div className="modal-actions">
          <button className="btn" onClick={reset}>
            {t.styleReset}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            {t.done}
          </button>
        </div>
      </div>
    </div>
  );
}
