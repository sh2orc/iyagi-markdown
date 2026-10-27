// 프런트매터 편집 대화상자 — title/author/date와 목차 스위치(toc/lof/lot)를
// 폼으로. 메타 구동 기능(57·92·95차)의 발견성 — YAML 키를 몰라도 쓴다.
// 저장은 원문의 FM 블록만 교체(나머지 불변, §4-2).

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { isolateHistory } from "@codemirror/commands";

import type { AppStore } from "../app/store";
import { frontMatterLen, frontMatterMeta, upsertFrontMatter } from "../editor/frontmatter";
import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
}

function fields(text: string) {
  const fm = frontMatterMeta(text);
  return { title: fm?.title ?? "", author: fm?.author ?? "", date: fm?.date ?? "",
    toc: !!fm?.toc, lof: !!fm?.lof, lot: !!fm?.lot, noCover: fm?.cover === false };
}

export function FrontMatterDialog({ store, t, onClose }: Props): JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [target] = useState(() => {
    const tab = store.active, view = store.view;
    if (!tab || !view) return null;
    const text = view.state.doc.toString();
    return { tab, view, header: text.slice(0, frontMatterLen(text)), fields: fields(text) };
  });
  const [draft, setDraft] = useState(() => target?.fields ?? fields(""));
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const titleId = useId();
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const targetProblem = !target || state.activeId !== target.tab.id || !state.tabs.includes(target.tab)
    || store.view !== target.view ? t.fmTargetChanged
    : target.view.state.readOnly ? t.fmReadOnly : null;
  const dirty = target && (Object.keys(draft) as Array<keyof typeof draft>)
    .some((key) => draft[key] !== target.fields[key]);
  const cancel = () => { if (dirty) setDiscard(true); else onClose(); };

  const save = () => {
    if (!target || store.active !== target.tab || store.view !== target.view) {
      setError(t.fmTargetChanged); return;
    }
    const view = target.view;
    if (view.state.readOnly) { setError(t.fmReadOnly); return; }
    const text = view.state.doc.toString();
    const oldLength = frontMatterLen(text);
    if (text.slice(0, oldLength) !== target.header) { setError(t.fmChanged); return; }
    const patch: Record<string, string | boolean | null> = {};
    for (const key of ["title", "author", "date"] as const) {
      if (draft[key] !== target.fields[key]) patch[key] = draft[key].trim() || null;
    }
    for (const key of ["toc", "lof", "lot"] as const) {
      if (draft[key] !== target.fields[key]) patch[key] = draft[key];
    }
    if (draft.noCover !== target.fields.noCover) patch.cover = draft.noCover ? false : null;
    try {
      const next = upsertFrontMatter(text, patch);
      if (next !== text) {
        // Keep the body outside the change range so selections, bookmarks and
        // comment positions map through a metadata-only transaction.
        const insertedLength = next.length - (text.length - oldLength);
        view.dispatch({
          changes: { from: 0, to: oldLength, insert: next.slice(0, insertedLength) },
          annotations: isolateHistory.of("full"), userEvent: "input.frontmatter",
        });
        if (view.state.doc.toString() !== next) { setError(t.fmApplyFailed); return; }
        store.toast(t.fmSaved);
      }
      onClose();
      view.focus();
    } catch (cause) {
      setError(`${t.fmApplyFailed} ${String(cause)}`);
    }
  };

  const check = (label: string, v: boolean, set: (b: boolean) => void, hint: string) => (
    <label className="settings-check fm-check" title={hint}>
      <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );

  const ko = state.settings.language === "ko";
  // 텍스트 입력에서 Enter=저장. Esc/배경/취소는 동일한 입력 보존 경로.
  const onFieldKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (imeComposing(e)) return; // IME 조합 중 키는 IME가 소비(한글 Esc·Enter 새기기 방지)
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
  };

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onClick={(e) => e.target === e.currentTarget && cancel()}
      onKeyDown={(event) => {
        if (imeComposing(event)) return;
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation();
          if (discard) setDiscard(false); else cancel();
        }
      }}
    >
      <div className="modal fm-dialog">
        <div className="modal-title" id={titleId}>{t.fmTitle}
          {target && <span className="modal-file-name">{target.tab.path ? target.tab.title : t.untitled}</span>}
        </div>
        <label className="settings-label">
          {t.fmDocTitle}
          <input
            ref={titleRef}
            value={draft.title}
            placeholder={ko ? "3분기 보고서" : "Q3 report"}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            onKeyDown={onFieldKey}
          />
        </label>
        <label className="settings-label">
          {t.fmAuthor}
          <input
            value={draft.author}
            placeholder={ko ? "홍길동" : "Jane Doe"}
            onChange={(e) => setDraft({ ...draft, author: e.target.value })}
            onKeyDown={onFieldKey}
          />
        </label>
        <label className="settings-label">
          {t.fmDate}
          <input
            value={draft.date}
            placeholder="2026-10-13"
            onChange={(e) => setDraft({ ...draft, date: e.target.value })}
            onKeyDown={onFieldKey}
          />
        </label>
        <div className="fm-toggles">
          {check(t.fmNoCover, draft.noCover, (noCover) => setDraft({ ...draft, noCover }), t.fmNoCoverHint)}
          {check(t.fmToc, draft.toc, (toc) => setDraft({ ...draft, toc }), t.fmTocHint)}
          {check(t.fmLof, draft.lof, (lof) => setDraft({ ...draft, lof }), t.fmLofHint)}
          {check(t.fmLot, draft.lot, (lot) => setDraft({ ...draft, lot }), t.fmLotHint)}
        </div>
        {(targetProblem || error) && <p className="comment-error" role="alert">{targetProblem || error}</p>}
        {discard ? <div className="comment-error" role="alert">
          <p>{t.fmDiscardPrompt}</p>
          <button className="btn" onClick={() => { setDiscard(false); titleRef.current?.focus(); }}>{t.commentKeepEditing}</button>
          <button className="btn btn-plain" onClick={onClose}>{t.commentDiscard}</button>
        </div> :
        <div className="modal-actions">
          <button className="btn btn-primary" disabled={!!targetProblem} onClick={save}>
            {t.save}
          </button>
          <button className="btn btn-plain" onClick={cancel}>
            {t.cancel}
          </button>
        </div>}
      </div>
    </div>
  );
}
