// 상태 줄 — 모드 전환·커서 위치·단어 수·설정 진입.

import { countWords, type AppStore } from "../app/store";
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
  // 통계는 스토어가 증분 유지한다 — 여기서 문서를 다시 훑지 않는다.
  const dirty = tab?.dirty ?? false;
  const words = tab?.words ?? 0;
  const chars = tab?.chars ?? 0;
  // 선택 통계 — 선택 중일 때만 (O(선택 길이)).
  const sel = tab?.state.selection.main;
  const selText = sel && !sel.empty ? tab!.state.doc.sliceString(sel.from, sel.to) : null;

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
            {tab.selChars > 0 ? (
              <span className="status-cell status-sel">
                {t.f.words(countWords(selText ?? ""))} · {t.f.chars(tab.selChars)} {t.sel}
              </span>
            ) : (
              <>
                <span className="status-cell">{t.f.words(words)}</span>
                <span className="status-cell">{t.f.chars(chars)}</span>
              </>
            )}
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

