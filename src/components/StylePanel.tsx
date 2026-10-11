// 문서 스타일 패널 — 이 문서만의 폰트·크기·행간·간격·강조색.
// 저장은 SQLite 사이드카(원문 .md는 불변), 변경은 즉시 미리보기에 반영.

import { useState } from "react";

import { api, isInApp, type DocStyle } from "../api";
import type { AppStore } from "../app/store";
import { DEFAULT_DOC_STYLE } from "../app/docStyle";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  onClose: () => void;
  t: Translate;
}

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
    <div className="overlay modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">
        <div className="modal-title">
          {t.styleTitle}
          <span className="modal-file-name">{tab.path ? tab.title : t.untitled}</span>
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
            {t.styleSpacing}
            <div className="style-font-row">
              {(["tight", "normal", "relaxed"] as const).map((p) => (
                <button
                  key={p}
                  className={`style-font-btn ${style.paraSpace === p ? "is-on" : ""}`}
                  onClick={() => update({ paraSpace: p })}
                >
                  {p === "tight" ? t.styleTight : p === "normal" ? t.styleNormal : t.styleRelaxed}
                </button>
              ))}
            </div>
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
        </div>
        <p className="modal-hint">스타일은 앱 데이터베이스에 저장됩니다 — .md 원문은 수정되지 않습니다.</p>
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
