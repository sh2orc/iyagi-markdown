// 패널을 열 때의 문서와 편집을 시작할 때의 메모 내용을 보존한다.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { AppStore } from "../app/store";
import type { DocComment } from "../api";
import { imeComposing } from "../app/ime";
import { smoothScrollIntoView } from "../editor/cm";
import { shiftLineNo } from "../editor/trackChanges";
import type { Translate } from "../i18n";
import { CommentDialog } from "./CommentDialog";

interface Props { store: AppStore; t: Translate; onClose: () => void; }

export function CommentsPanel({ store, t, onClose }: Props): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [target] = useState(() => ({ id: store.active?.id ?? "", path: store.active?.path ?? "", title: store.active?.title ?? t.untitled }));
  const tab = state.tabs.find((item) => item.id === target.id && item.path === target.path);
  const [editing, setEditing] = useState<DocComment | null>(null);
  const [deleting, setDeleting] = useState<DocComment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const comments = tab?.comments ?? [];
  const unresolved = comments.filter((comment) => !comment.resolved);
  const resolved = comments.filter((comment) => comment.resolved);
  useEffect(() => {
    alive.current = true;
    overlayRef.current?.focus();
    void store.refreshComments(target.path);
    return () => { alive.current = false; };
  }, [store, target.path]);
  useEffect(() => {
    if (!editing) returnFocus.current?.focus();
  }, [editing]);

  const close = () => { if (!busyRef.current && !editing) onClose(); };
  const mutate = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await operation(); if (alive.current) setDeleting(null); }
    catch (cause) { if (alive.current) setError(String(cause)); }
    finally {
      busyRef.current = false;
      if (alive.current) { setBusy(false); overlayRef.current?.focus(); }
    }
  };
  const closeEditor = () => { setEditing(null); };
  const goto = (lineNo: number) => {
    if (!tab) return;
    store.activate(tab.id);
    const view = store.view;
    if (!view) return;
    const mapped = shiftLineNo(lineNo, tab.savedText, view.state.doc.toString());
    const line = view.state.doc.line(Math.min(Math.max(mapped, 1), view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from } });
    smoothScrollIntoView(view, line.from);
  };
  const rows = (items: DocComment[]) => (
    <ul className="cmt-list" aria-label={t.commentsTitle}>
      {items.map((comment) => (
        <li key={comment.id} className={`cmt-row ${comment.resolved ? "is-resolved" : ""}`}>
          <button className="cmt-goto" title={t.commentGoto} disabled={!tab || busy || !!deleting || !!editing} onClick={() => goto(comment.lineNo)}>
            <span className="cmt-line">{comment.lineNo}</span><span className="cmt-text">{comment.text}</span>
          </button>
          <div className="cmt-actions">
            <button className="cmt-act" title={t.commentEdit} aria-label={t.commentEdit} disabled={!tab || busy || !!deleting || !!editing}
              onClick={(event) => { returnFocus.current = event.currentTarget; setEditing({ ...comment }); }}>✎</button>
            <button className="cmt-act" title={comment.resolved ? t.commentUnresolve : t.commentResolveBtn}
              aria-label={comment.resolved ? t.commentUnresolve : t.commentResolveBtn} disabled={!tab || busy || !!deleting || !!editing}
              onClick={() => void mutate(() => store.resolveComment(target, comment))}>{comment.resolved ? "↺" : "✓"}</button>
            <button className="cmt-act cmt-act-del" title={t.commentDelete} aria-label={t.commentDelete} disabled={!tab || busy || !!deleting || !!editing}
              onClick={() => { setError(null); setDeleting({ ...comment }); }}>×</button>
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <div ref={overlayRef} tabIndex={-1} className="overlay modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (imeComposing(event) || editing) return;
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation();
          if (deleting && !busyRef.current) setDeleting(null); else close();
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && (event.target as HTMLElement).classList.contains("cmt-goto")) {
          event.preventDefault();
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".cmt-goto")];
          const index = buttons.indexOf(event.target as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
          buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
        }
      }}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="modal comments-modal" aria-busy={busy || tab?.commentsLoading}>
        <div className="modal-title" id={titleId}>{t.commentsTitle}
          <span className="modal-file-name">{target.title} · {unresolved.length}</span>
        </div>
        {!tab && <div className="comment-error" role="alert">{target.path ? t.commentTargetChanged : t.commentSaveDocument}</div>}
        {tab?.commentsLoading && <div className="palette-empty" role="status">{t.loading}</div>}
        {tab?.commentsError && <div className="comment-error" role="alert">{t.commentsLoadFailed}: {tab.commentsError}
          <button className="btn" disabled={tab.commentsLoading || busy} onClick={() => void store.refreshComments(target.path)}>{t.wsRetry}</button>
        </div>}
        {tab?.commentsLoaded && !tab.commentsLoading && !tab.commentsError && !comments.length && <div className="palette-empty">{t.commentsEmpty}</div>}
        {!!unresolved.length && rows(unresolved)}
        {!!resolved.length && <><div className="sidebar-subtitle cmt-resolved-head">✓ {t.commentsResolved} ({resolved.length})</div>{rows(resolved)}</>}
        {error && <div className="comment-error" role="alert">{t.commentSaveFailed}: {error}</div>}
        {deleting && <div className="comment-error" role="alert">
          <p>{t.commentDeletePrompt}</p><blockquote>{deleting.text}</blockquote>
          <button className="btn" disabled={busy || !tab} onClick={() => void mutate(() => store.removeComment(target, deleting))}>{busy ? t.commentSaving : t.commentDelete}</button>
          <button className="btn btn-plain" disabled={busy} onClick={() => setDeleting(null)}>{t.cancel}</button>
        </div>}
        <div className="modal-actions"><button className="btn btn-primary" disabled={busy} onClick={close}>{t.done}</button></div>
      </div>
      {editing && <CommentDialog t={t} title={target.title} lineNo={editing.lineNo} initial={editing.text} onCancel={closeEditor}
        onConfirm={async (text) => { await store.editComment(target, editing, text); closeEditor(); }} />}
    </div>
  );
}
