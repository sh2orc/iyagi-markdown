// 문서 검수 허브 — 흩어진 검사를 한 곳에서: 끊긴 링크·긴 문장·고아 이미지.
// 고아 이미지(assets/에서 참조 없는 파일)는 여기서 처음으로 UI를 가진다.

import { useEffect, useState } from "react";

import { api, isInApp } from "../api";
import type { AppStore } from "../app/store";
import { sentenceLengthStats } from "../editor/writing";
import { brokenWikiLinks } from "../editor/brokenLinks";
import { resolveWikiLink } from "../editor/wiki";
import { stripFrontMatter } from "../editor/frontmatter";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onOpenBrokenLinks: () => void;
  onOpenStats: () => void;
  onOpenTrack: () => void;
}

interface Orphan {
  path: string;
  size: number;
}

export function ReviewPanel({ store, t, onClose, onOpenBrokenLinks, onOpenStats, onOpenTrack }: Props): JSX.Element | null {
  const tab = store.active;
  const [orphans, setOrphans] = useState<Orphan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState(0);

  // 긴 문장 수 — 통계 모듈 재사용(본문만).
  const body = tab ? stripFrontMatter(tab.state.doc.toString()) : "";
  const longSentences = sentenceLengthStats(body).longCount;
  // 끊긴 위키링크 수 — 패널과 같은 판정(워크스페이스 인덱스로).
  const raw = tab ? tab.state.doc.toString() : "";
  const dir = tab?.path ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/" : store.state.workspace ?? "";
  const brokenCount =
    tab && store.state.workspace
      ? brokenWikiLinks(stripFrontMatter(raw), (name) => resolveWikiLink(name, dir, store.wikiIndex)).length
      : -1; // -1 = 워크스페이스 없음(판정 불가)

  // 고아 이미지 — 워크스페이스 루트 대상, 열 때 1회 스캔.
  useEffect(() => {
    if (!isInApp() || !store.state.workspace) {
      setOrphans([]);
      return;
    }
    let disposed = false;
    setOrphans(null);
    void api
      .findOrphanImages(store.state.workspace)
      .then((list) => {
        if (!disposed) setOrphans(list);
      })
      .catch(() => setOrphans([]));
    return () => {
      disposed = true;
    };
    // 마운트 시 1회 — 워크스페이스 바뀌면 패널을 다시 연다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!tab) return null;

  const deleteAll = async () => {
    if (!orphans || orphans.length === 0 || busy) return;
    setBusy(true);
    try {
      const n = await api.deleteOrphanImages(orphans.map((o) => o.path));
      setRemoved(n);
      setOrphans([]);
      store.toast(t.f.reviewOrphanDone(n));
    } catch {
      store.toast(t.reviewOrphanFail, "error");
    } finally {
      setBusy(false);
    }
  };

  const fmtSize = (n: number): string =>
    n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`;

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal review-modal">
        <div className="modal-title">
          {t.reviewTitle}
          <span className="modal-file-name">{store.state.workspace ?? ""}</span>
        </div>

        <div className="review-grid">
          <section className="review-card">
            <h3>{t.reviewTrack}</h3>
            <p className="review-count">
              {tab.trackStats ? `+${tab.trackStats.added} −${tab.trackStats.removed}` : "—"}
            </p>
            <button className="review-open" onClick={onOpenTrack}>
              {t.reviewOpenTrack}
            </button>
          </section>
          <section className="review-card">
            <h3>{t.reviewLinks}</h3>
            {brokenCount >= 0 && <p className="review-count">{brokenCount}</p>}
            <button className="review-open" onClick={onOpenBrokenLinks} disabled={brokenCount === -1}>
              {t.reviewOpenLinks}
            </button>
          </section>
          <section className="review-card">
            <h3>{t.reviewSentences}</h3>
            <p className="review-count">{longSentences}</p>
            <button className="review-open" onClick={onOpenStats}>
              {t.reviewOpenStats}
            </button>
          </section>
          <section className="review-card review-card-wide">
            <h3>{t.reviewOrphans}</h3>
            {orphans === null && <div className="spinner review-spin" />}
            {orphans !== null && orphans.length === 0 && (
              <p className="review-ok">{removed > 0 ? t.f.reviewOrphanDone(removed) : t.reviewOrphanNone}</p>
            )}
            {orphans !== null && orphans.length > 0 && (
              <>
                <ul className="review-orphans">
                  {orphans.slice(0, 12).map((o) => (
                    <li key={o.path} title={o.path}>
                      <span className="review-orphan-name">{o.path.split("/").pop()}</span>
                      <span className="review-orphan-size">{fmtSize(o.size)}</span>
                    </li>
                  ))}
                </ul>
                <button className="btn btn-danger review-del" disabled={busy} onClick={() => void deleteAll()}>
                  {t.f.reviewOrphanDelete(orphans.length)}
                </button>
              </>
            )}
          </section>
        </div>

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            {t.done}
          </button>
        </div>
      </div>
    </div>
  );
}
