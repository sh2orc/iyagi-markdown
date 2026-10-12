// 상태 줄 — 모드 전환·커서 위치·단어 수·설정 진입.

import { useEffect, useState } from "react";

import { countWords, type AppStore } from "../app/store";
import { collectHeadings, type Heading } from "../links";
import { headingPath } from "../app/tocTree";
import { smoothScrollIntoView } from "../editor/cm";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onOpenSettings: () => void;
  onOpenStyle: () => void;
  onOpenStats: () => void;
  onOpenBacklinks: () => void;
}

export function StatusBar({ store, t, onOpenSettings, onOpenStyle, onOpenStats, onOpenBacklinks }: Props): JSX.Element {
  const state = store.getSnapshot();
  const tab = state.tabs.find((x) => x.id === state.activeId) ?? null;
  // 브레드크럼 — 커서가 속한 제목 경로. 편집이 멈춘 뒤 재계산(타이핑마다
  // 전체 재스캔이 되지 않게 — 목차 패널과 같은 디바운스).
  const [crumbs, setCrumbs] = useState<Heading[]>([]);
  const doc = tab?.state.doc;
  const cursor = tab?.state.selection.main.head ?? 0;
  useEffect(() => {
    if (!doc) {
      setCrumbs([]);
      return;
    }
    const id = setTimeout(() => {
      setCrumbs(headingPath(collectHeadings(doc.toString()), cursor));
    }, 150);
    return () => clearTimeout(id);
  }, [doc, cursor]);
  // 통계는 스토어가 증분 유지한다 — 여기서 문서를 다시 훑지 않는다.
  const dirty = tab?.dirty ?? false;
  const words = tab?.words ?? 0;
  const chars = tab?.chars ?? 0;
  // 선택 통계 — 선택 중일 때만. 단어 수 세기는 선택이 클 때(전체 선택 드래그
  // 등) 프레임을 태우므로 작은 선택까지만, 그 위는 글자 수만 보여 준다.
  const sel = tab?.state.selection.main;
  const selLen = sel && !sel.empty ? sel.to - sel.from : 0;
  const selWords =
    sel && !sel.empty && selLen <= 50_000
      ? countWords(tab!.state.doc.sliceString(sel.from, sel.to))
      : null;

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
        {crumbs.length > 0 && (
          <span className="status-crumbs" title={crumbs.map((c) => c.text).join(" › ")}>
            {crumbs.map((c, i) => (
              <button
                key={`${c.slug}-${i}`}
                className="status-crumb"
                onClick={() => {
                  const view = store.view;
                  if (!view) return;
                  smoothScrollIntoView(view, Math.min(c.pos, view.state.doc.length));
                }}
              >
                {c.text}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="statusbar-right">
        {tab && (
          <>
            <span className="status-cell">{t.ln} {tab.cursorLine}</span>
            <span className="status-cell">{t.col} {tab.cursorCol}</span>
            {tab.selChars > 0 ? (
              <span className="status-cell status-sel">
                {selWords != null ? `${t.f.words(selWords)} · ` : ""}
                {t.f.chars(tab.selChars)} {t.sel}
              </span>
            ) : (
              <>
                <button className="status-cell status-stat-btn" title={t.statsTitle} onClick={onOpenStats}>
                  {t.f.words(words)} · {t.f.chars(chars)}
                </button>
              </>
            )}
            {store.speaking && (
              <button
                className="status-cell status-speaking"
                title={t.speakStop}
                onClick={() => store.speakStop()}
              >
                🔊 {t.speakStop}
              </button>
            )}
            {tab.backlinks !== null && tab.backlinks > 0 && (
              <button
                className="status-cell status-backlinks"
                title={t.backlinksTitle}
                onClick={onOpenBacklinks}
              >
                🔗 {tab.backlinks}
              </button>
            )}
            {tab.checkbox && tab.checkbox.total > 0 && (
              <span
                className={`status-cell status-check ${tab.checkbox.done >= tab.checkbox.total ? "status-check-done" : ""}`}
                title={t.checkProgress}
              >
                ☑ {tab.checkbox.done}/{tab.checkbox.total}
              </span>
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

