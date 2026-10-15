// 시작 화면(Word 시작 페이지 방향) — 문서가 없을 때: 빠른 동작 3종 +
// 최근 문서 + 템플릿 바로가기. 첫 사용자의 동작 경로를 한 화면에 둔다.

import { useEffect, useRef, useState } from "react";

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

/** 템플릿 h2 목차 — 버튼 아래 힌트 줄에 보여 준다(구조만으로 고르게). */
function tplOutline(content: string): string {
  return content
    .split("\n")
    .filter((l) => /^##\s+/.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" · ");
}

export function Welcome({ store, t, lang, onOpenFile, onOpenFolder }: Props): JSX.Element {
  const [recent, setRecent] = useState<RecentEntry[] | null>(null);
  const [tplHint, setTplHint] = useState<string | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);

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
            {DOC_TEMPLATES.map((tpl) => {
              // 언어별 골격 — 영어 변형이 없는 템플릿은 한국어 본문 그대로.
              const body = lang === "ko" || tpl.contentEn == null ? tpl.content : tpl.contentEn;
              return (
                <button
                  key={tpl.id}
                  className="welcome-tpl"
                  onClick={() => store.newTabWithContent(body)}
                  onMouseEnter={() => setTplHint(tplOutline(body) || null)}
                  onFocus={() => setTplHint(tplOutline(body) || null)}
                  onMouseLeave={() => setTplHint(null)}
                  onBlur={() => setTplHint(null)}
                >
                  {lang === "ko" ? tpl.nameKo : tpl.nameEn}
                </button>
              );
            })}
          </div>
          {/* 호버/포커스 중인 템플릿의 목차 — 항상 자리를 차지해 점프 없게. */}
          <div className="welcome-tpl-hint">{tplHint ?? (lang === "ko" ? "형식 위에 올려 구조를 확인" : "Hover a format to see its structure")}</div>
        </div>
      </div>
    </div>
  );
}
