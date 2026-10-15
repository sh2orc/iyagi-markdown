// 변경 내용 패널(Word 검토 창) — 베이스라인 대비 바뀐 덩어리 목록:
// 클릭 이동·추가/삭제 구분·모두 수락. 표시는 장식(118차)이 이미 담당.
// 키보드: ↑↓ 선택·Enter 이동·Esc 닫기(메모·백링크 패널과 같은 규약).

import { useEffect, useMemo, useRef, useState } from "react";

import type { AppStore } from "../app/store";
import { hunksOf, type TrackHunk } from "../editor/trackChanges";
export { hunksOf } from "../editor/trackChanges";
export type { TrackHunk as Hunk } from "../editor/trackChanges";
import { smoothScrollIntoView } from "../editor/cm";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
}

/** 덩어리 되돌리기 변경 — add는 그 줄 삭제, del은 베이스라인 텍스트 재삽입.
 *  순수 함수. docs는 현재 문서의 줄 수(경계 검증용). */
export function revertChange(h: TrackHunk, lineText: (n: number) => { from: number; to: number }, docLines: number): { from: number; to: number; insert: string } | null {
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



export function TrackPanel({ store, t, onClose }: Props): JSX.Element | null {
  const tab = store.active;
  const [sel, setSel] = useState(0);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  const hunks = useMemo(
    () => (tab?.baselineText != null ? hunksOf(tab.baselineText, tab.state.doc.toString()) : []),
    [tab?.baselineText, tab?.state.doc],
  );

  // 오버레이 자체에 포커스를 둬 키보드 탐색이 가능하게(입력창이 없으므로).
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  // 목록이 줄면 선택 클램프 + 선택 행이 보이게.
  const cur = Math.min(sel, Math.max(0, hunks.length - 1));
  useEffect(() => {
    rowEls.current[cur]?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  if (!tab) return null;

  const revertTrackHunk = (h: TrackHunk) => {
    const view = store.view;
    if (!view || tab.baselineText == null) return;
    const ch = revertChange(h, (n) => view.state.doc.line(n), view.state.doc.lines);
    if (!ch) return;
    view.dispatch({
      changes: { from: ch.from, to: ch.to, insert: ch.insert },
      userEvent: "input.revertTrackHunk",
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
      ref={overlayRef}
      tabIndex={-1}
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        // 되돌리기·액션 버튼에 포커스가 있을 때는 그쪽 키 처리에 맡긴다.
        if (e.target !== e.currentTarget) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSel((v) => Math.min(v + 1, hunks.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSel((v) => Math.max(v - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const h = hunks[cur];
          if (h) goto(h.line);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
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
              <div
                key={i}
                ref={(el) => {
                  rowEls.current[i] = el;
                }}
                className={`track-item track-${h.kind} ${i === cur ? "is-sel" : ""}`}
                onMouseEnter={() => setSel(i)}
              >
                <button className="track-goto" onClick={() => goto(h.line)}>
                  <span className="track-badge">{h.kind === "add" ? `+${h.lines}` : `−${h.lines}`}</span>
                  <span className="track-line">{h.line}줄</span>
                  <span className="track-text">{h.preview}</span>
                </button>
                <button className="track-revert" title={t.trackRevert} onClick={() => revertTrackHunk(h)}>
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
