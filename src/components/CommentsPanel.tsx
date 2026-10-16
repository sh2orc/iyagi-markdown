// 메모 패널(Word "메모 창") — 문서의 메모 목록: 클릭 이동·편집·해결·삭제.
// 저장은 사이드카 — 원문 불변.
// 키보드: ↑↓ 선택·Enter 이동·Esc 닫기(백링크·버전 패널과 같은 규약).

import { useEffect, useRef, useState } from "react";

import type { AppStore } from "../app/store";
import { smoothScrollIntoView } from "../editor/cm";
import type { Translate } from "../i18n";
import { CommentDialog } from "./CommentDialog";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
}

export function CommentsPanel({ store, t, onClose }: Props): JSX.Element | null {
  const tab = store.active;
  const [editing, setEditing] = useState<{ id: number; lineNo: number; text: string } | null>(null);
  const [sel, setSel] = useState(0);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const rowEls = useRef<(HTMLDivElement | null)[]>([]);
  const comments = tab?.comments ?? [];
  const unresolved = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);
  // 미해결이 먼저 — 화면 순서와 같은 전체 색인(선택·이동의 기준).
  const ordered = [...unresolved, ...resolved];

  // 오버레이 자체에 포커스를 둬 키보드 탐색이 가능하게(입력창이 없으므로).
  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  // 목록이 줄면 선택 클램프 + 선택 행이 보이게.
  const cur = Math.min(sel, Math.max(0, ordered.length - 1));
  useEffect(() => {
    rowEls.current[cur]?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  if (!tab) return null;

  const goto = (lineNo: number) => {
    const view = store.view;
    if (!view) return;
    const line = view.state.doc.line(Math.min(Math.max(lineNo, 1), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from } });
    smoothScrollIntoView(view, line.from);
  };

  const row = (c: (typeof comments)[number], i: number) => (
    <div
      key={c.id}
      ref={(el) => {
        rowEls.current[i] = el;
      }}
      className={`cmt-row ${c.resolved ? "is-resolved" : ""} ${i === cur ? "is-sel" : ""}`}
      onMouseEnter={() => setSel(i)}
    >
      <button className="cmt-goto" title={t.commentGoto} onClick={() => goto(c.lineNo)}>
        <span className="cmt-line">{c.lineNo}</span>
        <span className="cmt-text">{c.text}</span>
      </button>
      <div className="cmt-actions">
        <button
          className="cmt-act"
          title={t.commentEdit}
          aria-label={t.commentEdit}
          onClick={() => setEditing({ id: c.id, lineNo: c.lineNo, text: c.text })}
        >
          ✎
        </button>
        <button
          className="cmt-act"
          title={c.resolved ? t.commentUnresolve : t.commentResolveBtn}
          aria-label={c.resolved ? t.commentUnresolve : t.commentResolveBtn}
          onClick={() => void store.resolveComment(c.id, !c.resolved)}
        >
          {c.resolved ? "↺" : "✓"}
        </button>
        <button
          className="cmt-act cmt-act-del"
          title={t.commentDelete}
          aria-label={t.commentDelete}
          onClick={() => void store.removeComment(c.id)}
        >
          ×
        </button>
      </div>
    </div>
  );

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onKeyDown={(e) => {
        // 편집 다이얼로그·버튼에 포커스가 있을 때는 그쪽 키 처리에 맡긴다.
        if (e.target !== e.currentTarget) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSel((v) => Math.min(v + 1, ordered.length - 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSel((v) => Math.max(v - 1, 0));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const c = ordered[cur];
          if (c) goto(c.lineNo);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal comments-modal">
        <div className="modal-title">
          {t.commentsTitle}
          <span className="modal-file-name">
            {tab.path ? tab.title : t.untitled} · {unresolved.length}
          </span>
        </div>
        {comments.length === 0 && <div className="palette-empty">{t.commentsEmpty}</div>}
        {unresolved.length > 0 && (
          <div className="cmt-list">{unresolved.map((c, i) => row(c, i))}</div>
        )}
        {resolved.length > 0 && (
          <>
            <div className="sidebar-subtitle cmt-resolved-head">
              ✓ {t.commentsResolved} ({resolved.length})
            </div>
            <div className="cmt-list">{resolved.map((c, i) => row(c, unresolved.length + i))}</div>
          </>
        )}
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            {t.done}
          </button>
        </div>
      </div>
      {editing && (
        <CommentDialog
          t={t}
          lineNo={editing.lineNo}
          initial={editing.text}
          onCancel={() => setEditing(null)}
          onConfirm={(text) => {
            const id = editing.id;
            setEditing(null);
            void store.editComment(id, text);
          }}
        />
      )}
    </div>
  );
}
