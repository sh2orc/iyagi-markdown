// 상태 줄 — 모드 전환·커서 위치·단어 수·설정 진입.

import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onOpenSettings: () => void;
  onOpenStyle: () => void;
}

export function StatusBar({ store, t, onOpenSettings, onOpenStyle }: Props): JSX.Element {
  const state = store.getSnapshot();
  const tab = state.tabs.find((x) => x.id === state.activeId) ?? null;
  const dirty = tab ? tab.state.doc.toString() !== tab.savedText : false;
  const text = tab?.state.doc.toString() ?? "";
  const words = countWords(text);
  const chars = text.length;

  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        <button
          className={`status-mode ${tab?.mode === "edit" ? "is-on" : ""}`}
          onClick={() => store.setMode("edit")}
          title={t.modeEdit}
        >
          {t.modeEdit}
        </button>
        <button
          className={`status-mode ${tab?.mode === "read" ? "is-on" : ""}`}
          onClick={() => store.setMode("read")}
          title={t.modeRead}
        >
          {t.modeRead}
        </button>
        <button
          className={`status-mode ${tab?.mode === "source" ? "is-on" : ""}`}
          onClick={() => store.setMode("source")}
          title={t.modeSource}
        >
          {t.modeSource}
        </button>
      </div>
      <div className="statusbar-right">
        {tab && (
          <>
            <span className="status-cell">{t.ln} {tab.cursorLine}</span>
            <span className="status-cell">{t.col} {tab.cursorCol}</span>
            <span className="status-cell">{t.f.words(words)}</span>
            <span className="status-cell">{t.f.chars(chars)}</span>
            {dirty && <span className="status-dot" title={t.dirtyTitle} />}
          </>
        )}
        {tab?.path && (
          <button className="status-style" title={t.styleTitle} onClick={onOpenStyle}>
            Aa
          </button>
        )}
        <button className="status-settings" title={t.settingsTitle} onClick={onOpenSettings}>
          ⚙
        </button>
      </div>
    </footer>
  );
}

function countWords(text: string): number {
  // 한글은 음절을, 라틴은 단어를 센다 — 대략적 지표.
  const cjk = (text.match(/[가-힣぀-ヿ一-鿿]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z0-9'’_-]+/g) ?? []).length;
  return cjk + latin;
}
