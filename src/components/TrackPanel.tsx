// 변경 내용 패널(Word 검토 창) — 베이스라인 대비 바뀐 덩어리 목록:
// 클릭 이동·추가/삭제 구분·모두 수락. 표시는 장식(118차)이 이미 담당.

import { useMemo } from "react";

import type { AppStore } from "../app/store";
import { diffLines } from "../editor/diff";
import { smoothScrollIntoView } from "../editor/cm";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
}

interface Hunk {
  kind: "add" | "del";
  /** 현재 문서 줄(1-기준) — add는 그 줄, del은 다음 유지 줄(또는 문서 끝). */
  line: number;
  lines: number;
  preview: string;
}

/** diff 연산 → 덩어리 목록. 순수 함수(테스트 대상). */
export function hunksOf(baseline: string, current: string): Hunk[] {
  const ops = diffLines(baseline, current);
  const out: Hunk[] = [];
  let line = 0;
  for (const op of ops) {
    if (op.kind === "same") {
      line += op.text.split("\n").length;
    } else if (op.kind === "add") {
      const n = op.text.split("\n").length;
      out.push({
        kind: "add",
        line: line + 1,
        lines: n,
        preview: op.text.split("\n")[0] ?? "",
      });
      line += n;
    } else {
      out.push({
        kind: "del",
        line: line + 1,
        lines: op.text.split("\n").length,
        preview: op.text.split("\n")[0] ?? "",
      });
    }
  }
  return out;
}

export function TrackPanel({ store, t, onClose }: Props): JSX.Element | null {
  const tab = store.active;
  const hunks = useMemo(
    () => (tab?.baselineText != null ? hunksOf(tab.baselineText, tab.state.doc.toString()) : []),
    [tab?.baselineText, tab?.state.doc],
  );

  if (!tab) return null;

  const goto = (line: number) => {
    const view = store.view;
    if (!view) return;
    const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
    view.dispatch({ selection: { anchor: l.from } });
    smoothScrollIntoView(view, l.from);
  };

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal track-modal">
        <div className="modal-title">
          {t.trackPanelTitle}
          <span className="modal-file-name">
            {tab.trackStats ? `+${tab.trackStats.added} −${tab.trackStats.removed}` : ""}
          </span>
        </div>
        {tab.baselineText == null ? (
          <p className="review-ok">{t.trackNotActive}</p>
        ) : hunks.length === 0 ? (
          <p className="review-ok">{t.trackNoChanges}</p>
        ) : (
          <div className="track-list">
            {hunks.map((h, i) => (
              <button key={i} className={`track-item track-${h.kind}`} onClick={() => goto(h.line)}>
                <span className="track-badge">{h.kind === "add" ? `+${h.lines}` : `−${h.lines}`}</span>
                <span className="track-line">{h.line}줄</span>
                <span className="track-text">{h.preview}</span>
              </button>
            ))}
          </div>
        )}
        <div className="modal-actions">
          {tab.baselineText != null && (
            <>
              <button className="btn" onClick={() => void store.acceptAllChanges()}>
                {t.trackAccept}
              </button>
              <button className="btn btn-plain" onClick={() => void store.stopTracking()}>
                {t.trackStop}
              </button>
            </>
          )}
          <button className="btn btn-primary" onClick={onClose}>
            {t.done}
          </button>
        </div>
      </div>
    </div>
  );
}
