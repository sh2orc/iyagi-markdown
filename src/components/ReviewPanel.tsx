// 문서 검수 허브 — 흩어진 검사를 한 곳에서: 끊긴 링크·긴 문장·고아 이미지.
// 고아 이미지(assets/에서 참조 없는 파일)는 여기서 처음으로 UI를 가진다.

import { useEffect, useMemo, useRef, useState } from "react";

import { AssetCleanup } from "./AssetCleanup";
import { imeComposing } from "../app/ime";
import type { AppStore } from "../app/store";
import { sentenceLengthStats } from "../editor/writing";
import { useLinkInspection } from "./useLinkInspection";
import { stripFrontMatter } from "../editor/frontmatter";
import { brokenCitations, citationNumberingForDocument } from "../editor/citations";
import { smoothScrollIntoView } from "../editor/cm";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onOpenBrokenLinks: () => void;
  onOpenStats: () => void;
  onOpenTrack: () => void;
}

export function ReviewPanel({ store, t, onClose, onOpenBrokenLinks, onOpenStats, onOpenTrack }: Props): JSX.Element | null {
  const links = useLinkInspection(store);
  const tab = store.active;
  const [busy, setBusy] = useState(false);
  const overlay = useRef<HTMLDivElement | null>(null);
  useEffect(() => { overlay.current?.focus(); }, []);

  // 긴 문장 수 — 통계 모듈 재사용(본문만).
  // 끊긴 링크 수 — 패널과 같은 비동기 파일 검사.
  // 인용 — 고유 키 수(첫 등장 순)·끊긴 인용(정의 없는 키 사용처).
  // 문서·인덱스가 바뀔 때만 검사한다. 이미지 선택 상태가 바뀔 때 큰 본문을
  // 여러 번 훑지 않게 한다.
  const doc = tab?.state.doc;
  const raw = useMemo(() => doc?.toString() ?? "", [doc]);
  const body = useMemo(() => stripFrontMatter(raw), [raw]);
  // 긴 문장 기준은 사용자 설정(longSentenceMin) — 통계 패널·라이브 마커와
  // 같은 잣대(기본 60을 하드코딩하면 설정을 바꾼 문서에서 수가 어긋난다).
  const longMin = store.state.settings.longSentenceMin;
  const longSentences = useMemo(() => sentenceLengthStats(body, longMin).longCount, [body, longMin]);
  const citeNum = useMemo(() => (doc ? citationNumberingForDocument(doc) : null), [doc]);
  const brokenCites = useMemo(() => (citeNum ? brokenCitations(raw, citeNum) : []), [citeNum, raw]);

  /** 인용으로 이동 — 끊긴 것이 있으면 첫 사용처, 아니면 서지(첫 정의 줄). */
  const gotoCites = (): void => {
    const view = store.view;
    if (!view || !citeNum) return;
    let pos = brokenCites[0]?.pos;
    if (pos === undefined) {
      const first = citeNum.defs.values().next().value;
      if (first) pos = view.state.doc.line(Math.min(first.line, view.state.doc.lines)).from;
    }
    if (pos === undefined) return;
    onClose();
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
    smoothScrollIntoView(view, pos);
  };

  return (
    <div
      ref={overlay}
      tabIndex={-1}
      aria-labelledby="review-title"
      aria-busy={busy}
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onKeyDown={(event) => {
        if (imeComposing(event) || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onClose();
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="modal review-modal">
        <div className="modal-title" id="review-title">
          {t.reviewTitle}
          <span className="modal-file-name">{store.state.workspace ?? ""}</span>
        </div>

        <div className="review-grid">
          <section className="review-card">
            <h3>{t.reviewTrack}</h3>
            <p className="review-count">
              {tab?.trackStats ? `+${tab.trackStats.added} −${tab.trackStats.removed}` : "—"}
            </p>
            <button className="review-open" onClick={onOpenTrack} disabled={busy || !tab}>
              {t.reviewOpenTrack}
            </button>
          </section>
          <section className="review-card">
            <h3>{t.reviewLinks}</h3>
            <p className="review-count">{links.loading ? "…" : links.result?.data.links.length ?? "—"}</p>
            {(links.error || !!links.result?.data.issues.length) && <p>{t.brokenUnverified}</p>}
            <button className="review-open" onClick={onOpenBrokenLinks} disabled={busy || !tab || !links.workspace}>
              {t.reviewOpenLinks}
            </button>
          </section>
          <section className="review-card">
            <h3>{t.reviewSentences}</h3>
            <p className="review-count">{tab ? longSentences : "—"}</p>
            <button className="review-open" onClick={onOpenStats} disabled={busy || !tab}>
              {t.reviewOpenStats}
            </button>
          </section>
          <section className="review-card">
            <h3>{t.reviewCites}</h3>
            {citeNum && (
              <p className="review-count">
                {citeNum.order.length}
                {brokenCites.length > 0 && (
                  <span className="review-cite-warn" title={t.reviewCitesBroken}>
                    {" "}
                    ⚠{brokenCites.length}
                  </span>
                )}
              </p>
            )}
            <button
              className="review-open"
              disabled={busy || !citeNum || (citeNum.order.length === 0 && citeNum.defs.size === 0)}
              onClick={gotoCites}
            >
              {t.reviewOpenCites}
            </button>
          </section>
          <AssetCleanup store={store} t={t} onBusyChange={setBusy} />
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose} disabled={busy}>
            {t.done}
          </button>
        </div>
      </div>
    </div>
  );
}
