// 시작 화면(Word 시작 페이지 방향) — 문서가 없을 때: 빠른 동작 3종 +
// 최근 문서 + 템플릿 바로가기. 첫 사용자의 동작 경로를 한 화면에 둔다.

import { useEffect, useRef, useState } from "react";

import { RecentDocuments } from "./RecentDocuments";
import { FavoriteDocuments } from "./FavoriteDocuments";
import { RecentWorkspaces } from "./RecentWorkspaces";
import { DOC_TEMPLATES, templateName, templateOutline } from "../app/templates";
import type { AppStore } from "../app/store";
import type { Lang, Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  lang: Lang;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenTemplates: (initialId?: string) => void;
}

export function Welcome({ store, t, lang, onOpenFile, onOpenFolder, onOpenTemplates }: Props): JSX.Element {
  const [tplHint, setTplHint] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

  // 기본 동작(새 문서)에 포커스 — Enter로 바로 시작.
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="app-empty-mark">M↓</div>
        <div className="app-empty-title">{t.emptyNoDoc}</div>
        <div className="app-empty-hint">{t.emptyNoDocHint}</div>

        <div className="welcome-actions">
          <button ref={primaryRef} className="btn btn-primary" onClick={() => store.newTab()}>
            {t.newTab} ⌘N
          </button>
          <button className="btn" onClick={onOpenFile}>
            {lang === "ko" ? "파일 열기" : "Open file…"} ⌘O
          </button>
          <button className="btn" onClick={onOpenFolder}>
            {t.openFolder}
          </button>
        </div>

        <FavoriteDocuments store={store} t={t} limit={5} />
        <RecentWorkspaces store={store} t={t} limit={5} />
        <RecentDocuments store={store} t={t} limit={5} />

        <div className="welcome-section">
          <div className="sidebar-subtitle">{lang === "ko" ? "템플릿으로 시작" : "Start from template"}</div>
          <div className="welcome-templates">
            {DOC_TEMPLATES.map((tpl) => {
              return (
                <button
                  key={tpl.id}
                  className="welcome-tpl"
                  onClick={() => onOpenTemplates(tpl.id)}
                  onMouseEnter={() => setTplHint(templateOutline(tpl, lang) || null)}
                  onFocus={() => setTplHint(templateOutline(tpl, lang) || null)}
                  onMouseLeave={() => setTplHint(null)}
                  onBlur={() => setTplHint(null)}
                >
                  {templateName(tpl, lang)}
                </button>
              );
            })}
          </div>
          <button className="btn btn-plain" onClick={() => onOpenTemplates()}>{t.templateBrowse}</button>
          {/* 호버/포커스 중인 템플릿의 목차 — 항상 자리를 차지해 점프 없게. */}
          <div className="welcome-tpl-hint">{tplHint ?? (lang === "ko" ? "형식 위에 올려 구조를 확인" : "Hover a format to see its structure")}</div>
        </div>
      </div>
    </div>
  );
}
