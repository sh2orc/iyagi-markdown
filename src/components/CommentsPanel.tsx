// 메모 패널(Word "메모 창") — 문서의 메모 목록: 클릭 이동·편집·해결·삭제.
// 저장은 사이드카 — 원문 불변.

import { useState } from "react";

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
  if (!tab) return null;
  const comments = tab.comments ?? [];
  const unresolved = comments.filter((c) => !c.resolved);
  const resolved = comments.filter((c) => c.resolved);

  const goto = (lineNo: number) => {
    const view = store.view;
    if (!view) return;
    const line = view.state.doc.line(Math.min(Math.max(lineNo, 1), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from } });
    smoothScrollIntoView(view, line.from);
  };

  const row = (c: (typeof comments)[number]) => (
    <div key={c.id} className={`cm-row ${c.resolved ? "is-resolved" : ""}`}>
      <button className="cm-goto" title={t.commentGoto} onClick={() => goto(c.lineNo)}>
        <span className="cm-line">{c.lineNo}</span>
        <span className="cm-text">{c.text}</span>
      </button>
      <div className="cm-actions">
        <button
          className="cm-act"
          title={t.commentEdit}
          onClick={() => setEditing({ id: c.id, lineNo: c.lineNo, text: c.text })}
        >
          ✎
        </button>
        <button
          className="cm-act"
          title={c.resolved ? t.commentUnresolve : t.commentResolveBtn}
          onClick={() => void store.resolveComment(c.id, !c.resolved)}
        >
          {c.resolved ? "↺" : "✓"}
        </button>
        <button className="cm-act cm-act-del" title={t.commentDelete} onClick={() => void store.removeComment(c.id)}>
          ×
        </button>
      </div>
    </div>
  );

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
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
        {unresolved.length > 0 && <div className="cm-list">{unresolved.map(row)}</div>}
        {resolved.length > 0 && (
          <>
            <div className="sidebar-subtitle cm-resolved-head">
              ✓ {t.commentsResolved} ({resolved.length})
            </div>
            <div className="cm-list">{resolved.map(row)}</div>
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
