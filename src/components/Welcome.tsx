// 시작 화면(Word 시작 페이지 방향) — 문서가 없을 때: 빠른 동작 3종 +
// 최근 문서 + 템플릿 바로가기. 첫 사용자의 동작 경로를 한 화면에 둔다.

import { useEffect, useState } from "react";

import { api, isInApp, type RecentEntry } from "../api";
import { DOC_TEMPLATES } from "../app/templates";
import type { AppStore } from "../app/store";
import type { Lang, Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  lang: Lang;
  onOpenFile: () => void;
  onOpenFolder: () => void;
}

export function Welcome({ store, t, lang, onOpenFile, onOpenFolder }: Props): JSX.Element {
  const [recent, setRecent] = useState<RecentEntry[] | null>(null);

  useEffect(() => {
    if (!isInApp()) {
      setRecent([]);
      return;
    }
    let disposed = false;
    void api
      .getRecent()
      .then((r) => {
        if (!disposed) setRecent(r.slice(0, 5));
      })
      .catch(() => setRecent([]));
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="app-empty-mark">M↓</div>
        <div className="app-empty-title">{t.emptyNoDoc}</div>
        <div className="app-empty-hint">{t.emptyNoDocHint}</div>

        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={() => store.newTab()}>
            {t.newTab} ⌘N
          </button>
          <button className="btn" onClick={onOpenFile}>
            {lang === "ko" ? "파일 열기" : "Open file…"} ⌘O
          </button>
          <button className="btn" onClick={onOpenFolder}>
            {t.openFolder}
          </button>
        </div>

        {recent !== null && recent.length > 0 && (
          <div className="welcome-section">
            <div className="sidebar-subtitle">{t.recentSection}</div>
            <div className="welcome-recent">
              {recent.map((r) => (
                <button
                  key={r.path}
                  className="welcome-recent-item"
                  onClick={() => void store.openPath(r.path)}
                  title={r.path}
                >
                  <span className="welcome-recent-name">{r.name}</span>
                  <span className="welcome-recent-dir">
                    {r.path.split("/").slice(0, -1).slice(-2).join("/")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="welcome-section">
          <div className="sidebar-subtitle">{lang === "ko" ? "템플릿으로 시작" : "Start from template"}</div>
          <div className="welcome-templates">
            {DOC_TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                className="welcome-tpl"
                onClick={() => store.newTabWithContent(tpl.content)}
              >
                {lang === "ko" ? tpl.nameKo : tpl.nameEn}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
