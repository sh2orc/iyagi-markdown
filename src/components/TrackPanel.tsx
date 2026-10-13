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

export interface Hunk {
  kind: "add" | "del";
  /** 현재 문서 줄(1-기준) — add는 그 줄, del은 다음 유지 줄(또는 문서 끝). */
  line: number;
  lines: number;
  preview: string;
  /** add: 현재 문서에서 그 덩어리의 줄 범위. del: 미사용. */
  fromLine: number;
  toLine: number;
  /** del: 되돌려 넣을 베이스라인 텍스트(줄들). add: 미사용. */
  restore: string;
}

/** 덩어리 되돌리기 변경 — add는 그 줄 삭제, del은 베이스라인 텍스트 재삽입.
 *  순수 함수. docs는 현재 문서의 줄 수(경계 검증용). */
export function revertChange(h: Hunk, lineText: (n: number) => { from: number; to: number }, docLines: number): { from: number; to: number; insert: string } | null {
  if (h.kind === "add") {
    if (h.toLine > docLines || h.fromLine < 1) return null;
    let from = 0;
    let to = 0;
    for (let n = h.fromLine; n <= h.toLine; n++) {
      const t = lineText(n);
      if (n === h.fromLine) from = t.from;
      to = t.to;
    }
    // 덩어리 뒤의 개행까지 지워 줄 잔여 없게(마지막 줄이면 앞 개행).
    if (h.toLine < docLines) to += 1;
    else if (h.fromLine > 1) from -= 1;
    return { from, to, insert: "" };
  }
  // del — 그 위치에 베이스라인 줄들을 되살린다.
  const at = Math.min(h.line, docLines + 1);
  const anchor = lineText(Math.min(at, docLines));
  const pos = at > docLines ? anchor.to : anchor.from;
  return { from: pos, to: pos, insert: h.restore };
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
        fromLine: line + 1,
        toLine: line + n,
        restore: "",
      });
      line += n;
    } else {
      out.push({
        kind: "del",
        line: line + 1,
        lines: op.text.split("\n").length,
        preview: op.text.split("\n")[0] ?? "",
        fromLine: 0,
        toLine: 0,
        restore: op.text,
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

  const revertHunk = (h: Hunk) => {
    const view = store.view;
    if (!view || tab.baselineText == null) return;
    const ch = revertChange(h, (n) => view.state.doc.line(n), view.state.doc.lines);
    if (!ch) return;
    view.dispatch({
      changes: { from: ch.from, to: ch.to, insert: ch.insert },
      userEvent: "input.revertHunk",
    });
    store.toast(t.trackReverted);
  };

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
              <div key={i} className={`track-item track-${h.kind}`}>
                <button className="track-goto" onClick={() => goto(h.line)}>
                  <span className="track-badge">{h.kind === "add" ? `+${h.lines}` : `−${h.lines}`}</span>
                  <span className="track-line">{h.line}줄</span>
                  <span className="track-text">{h.preview}</span>
                </button>
                <button className="track-revert" title={t.trackRevert} onClick={() => revertHunk(h)}>
                  ↺
                </button>
              </div>
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
