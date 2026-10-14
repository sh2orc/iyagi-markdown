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
  onOpenComments: () => void;
  onOpenTrack: () => void;
}

export function StatusBar({ store, t, onOpenSettings, onOpenStyle, onOpenStats, onOpenBacklinks, onOpenComments, onOpenTrack }: Props): JSX.Element {
  const state = store.getSnapshot();
  const tab = state.tabs.find((x) => x.id === state.activeId) ?? null;
  // 브레드크럼 — 커서가 속한 제목 경로. 헤딩 목록은 문서가 바뀔 때만(디바운스)
  // 재스캔하고, 커서 이동은 캐시한 목록에서 경로만 즉시 계산한다(O(제목 수)).
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [crumbs, setCrumbs] = useState<Heading[]>([]);
  const doc = tab?.state.doc;
  const cursor = tab?.state.selection.main.head ?? 0;
  useEffect(() => {
    if (!doc) {
      setHeadings([]);
      return;
    }
    const id = setTimeout(() => {
      setHeadings(collectHeadings(doc.toString()));
    }, 150);
    return () => clearTimeout(id);
  }, [doc]);
  useEffect(() => {
    setCrumbs(headingPath(headings, cursor));
  }, [headings, cursor]);
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
                  {state.settings.writingGoal > 0 && (
                    <span
                      className={`status-goal ${words >= state.settings.writingGoal ? "is-done" : ""}`}
                      title={t.goalTitle}
                    >
                      {" "}· {Math.round((words / state.settings.writingGoal) * 100)}%
                    </span>
                  )}
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
            {tab.trackStats && tab.baselineText != null && (
              <button
                className={`status-cell status-track ${tab.trackStats.added + tab.trackStats.removed > 0 ? "has-changes" : ""}`}
                title={t.trackPanelTitle}
                onClick={onOpenTrack}
              >
                ✎ +{tab.trackStats.added} −{tab.trackStats.removed}
              </button>
            )}
            {(tab.comments?.filter((c) => !c.resolved).length ?? 0) > 0 && (
              <button
                className="status-cell status-comments"
                title={t.commentsTitle}
                onClick={onOpenComments}
              >
                💬 {tab.comments!.filter((c) => !c.resolved).length}
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
            {!dirty && tab.savedAt > 0 && (
              <span className="status-saved-at">
                {new Date(tab.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
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

