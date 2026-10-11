// 설정 시트(§4-7) — 설정 항목 10개 내외. 즉시 반영 + settings.json 저장.

import type { AppStore } from "../app/store";
import { api, isInApp, type Settings } from "../api";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  open: boolean;
  onClose: () => void;
  t: Translate;
}

export function SettingsSheet({ store, open, onClose, t }: Props): JSX.Element | null {
  if (!open) return null;
  const s = store.state.settings;
  const set = (patch: Partial<Settings>) => {
    const next = { ...s, ...patch };
    store.setSettings(next);
    if (isInApp()) void api.setSettings(next).catch(() => {});
  };

  return (
    <div className="overlay modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal">
        <div className="modal-title">{t.settingsTitle}</div>
        <div className="settings-grid">
          <label className="settings-label">
            {t.setAppearance}
            <select value={s.theme} onChange={(e) => set({ theme: e.target.value as Settings["theme"] })}>
              <option value="auto">{t.setThemeAuto}</option>
              <option value="light">{t.setThemeLight}</option>
              <option value="dark">{t.setThemeDark}</option>
            </select>
          </label>
          <label className="settings-label">
            {t.setFontSize} ({s.fontSize}px)
            <input
              type="range"
              min={9}
              max={28}
              value={s.fontSize}
              onChange={(e) => set({ fontSize: Number(e.target.value) })}
            />
          </label>
          <label className="settings-label">
            {t.setLineWidth} {s.lineWidth > 0 ? `(${s.lineWidth}px)` : `(${t.setLineWidthOff})`}
            <input
              type="range"
              min={0}
              max={1200}
              step={20}
              value={s.lineWidth}
              onChange={(e) => set({ lineWidth: Number(e.target.value) })}
            />
          </label>
          <label className="settings-label">
            {t.setDefaultMode}
            <select
              value={s.defaultMode}
              onChange={(e) => set({ defaultMode: e.target.value as Settings["defaultMode"] })}
            >
              <option value="edit">{t.modeEdit}</option>
              <option value="read">{t.modeRead}</option>
              <option value="source">{t.modeSource}</option>
            </select>
          </label>
          <label className="settings-label">
            {t.setLanguage}
            <select
              value={s.language}
              onChange={(e) => set({ language: e.target.value as Settings["language"] })}
            >
              <option value="auto">{t.setLangAuto}</option>
              <option value="ko">한국어</option>
              <option value="en">English</option>
            </select>
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.remoteImages}
              onChange={(e) => set({ remoteImages: e.target.checked })}
            />
            {t.setRemoteImages}
            <span className="settings-hint">{t.setRemoteImagesHint}</span>
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.showImages}
              onChange={(e) => set({ showImages: e.target.checked })}
            />
            {t.setShowImages}
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}
