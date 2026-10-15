// 설정 시트(§4-7) — 설정 항목 10개 내외. 즉시 반영 + settings.json 저장.
// 디스크 저장(및 settings-changed 이벤트 왕복)은 짧게 디바운스 — 슬라이더를
// 끌 때 매 틱마다 파일을 쓰지 않는다. 화면 반영은 즉시.

import { useEffect, useRef, useState } from "react";

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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [voices, setVoices] = useState<Array<{ name: string; lang: string }>>([]);
  useEffect(() => {
    if (!isInApp()) return;
    let disposed = false;
    void api
      .listVoices()
      .then((vs) => {
        if (!disposed) setVoices(vs);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
  const set = (patch: Partial<Settings>) => {
    const next = { ...store.state.settings, ...patch };
    store.setSettings(next); // 화면은 즉시
    if (isInApp()) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void api.setSettings(next).catch(() => {});
      }, 300);
    }
  };
  if (!open) return null;
  const s = store.state.settings;

  return (
    <div className="overlay modal-overlay" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
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
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.autoFormatTables}
              onChange={(e) => set({ autoFormatTables: e.target.checked })}
            />
            {t.setAutoFormatTables}
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.autosave}
              onChange={(e) => set({ autosave: e.target.checked })}
            />
            {t.setAutosave}
            <span className="settings-hint">{t.setAutosaveHint}</span>
          </label>
          <label className="settings-check">
            <input
              type="range"
              min={120}
              max={260}
              step={5}
              value={s.ttsRate}
              onChange={(e) => set({ ttsRate: Number(e.target.value) })}
            />
            {t.setTtsRate}
            <span className="settings-hint">{s.ttsRate} wpm</span>
          </label>
          <label className="settings-check">
            <select
              value={s.ttsVoice}
              onChange={(e) => set({ ttsVoice: e.target.value })}
            >
              <option value="">{t.setTtsVoiceDefault}</option>
              {voices.map((v) => (
                <option key={`${v.name}-${v.lang}`} value={v.name}>
                  {v.name} ({v.lang})
                </option>
              ))}
            </select>
            {t.setTtsVoice}
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.spellcheck}
              onChange={(e) => set({ spellcheck: e.target.checked })}
            />
            {t.setSpellcheck}
            <span className="settings-hint">{t.setSpellcheckHint}</span>
          </label>
          <label className="settings-label">
            {t.goalTitle} ({s.writingGoal > 0 ? Math.round(s.writingGoal).toLocaleString() : t.goalOff})
            <input
              type="range"
              min={0}
              max={20000}
              step={250}
              value={s.writingGoal}
              onChange={(e) => set({ writingGoal: Number(e.target.value) })}
            />
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.smartPunctuation}
              onChange={(e) => set({ smartPunctuation: e.target.checked })}
            />
            {t.setSmartPunct}
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.longSentenceMarks}
              onChange={(e) => set({ longSentenceMarks: e.target.checked })}
            />
            {t.setLongSentence}
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.formattingMarks}
              onChange={(e) => set({ formattingMarks: e.target.checked })}
            />
            {t.setFormattingMarks}
          </label>
          <label className="settings-label">
            {t.setLongSentenceMin} ({Math.round(s.longSentenceMin)})
            <input
              type="range"
              min={40}
              max={120}
              step={5}
              value={s.longSentenceMin}
              onChange={(e) => set({ longSentenceMin: Number(e.target.value) })}
            />
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.typewriter}
              onChange={(e) => set({ typewriter: e.target.checked })}
            />
            {t.setTypewriter}
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.focusMode}
              onChange={(e) => set({ focusMode: e.target.checked })}
            />
            {t.setFocusMode}
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.focusSentence}
              onChange={(e) => set({ focusSentence: e.target.checked })}
            />
            {t.setFocusSentence}
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
