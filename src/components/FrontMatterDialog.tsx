// 프런트매터 편집 대화상자 — title/author/date와 목차 스위치(toc/lof/lot)를
// 폼으로. 메타 구동 기능(57·92·95차)의 발견성 — YAML 키를 몰라도 쓴다.
// 저장은 원문의 FM 블록만 교체(나머지 불변, §4-2).

import { useEffect, useRef, useState } from "react";

import type { AppStore } from "../app/store";
import { frontMatterMeta, upsertFrontMatter } from "../editor/frontmatter";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
}

export function FrontMatterDialog({ store, t, onClose }: Props): JSX.Element | null {
  const tab = store.active;
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [date, setDate] = useState("");
  const [toc, setToc] = useState(false);
  const [lof, setLof] = useState(false);
  const [lot, setLot] = useState(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!tab) return;
    const fm = frontMatterMeta(tab.state.doc.toString());
    setTitle(fm?.title ?? "");
    setAuthor(fm?.author ?? "");
    setDate(fm?.date ?? "");
    setToc(!!fm?.toc);
    setLof(!!fm?.lof);
    setLot(!!fm?.lot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id]);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  if (!tab) return null;

  const save = () => {
    const view = store.view;
    if (!view) return;
    const next = upsertFrontMatter(view.state.doc.toString(), {
      title: title.trim() || null,
      author: author.trim() || null,
      date: date.trim() || null,
      toc,
      lof,
      lot,
    });
    onClose();
    if (next !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        userEvent: "input.frontmatter",
      });
      view.focus();
      store.toast(t.fmSaved);
    }
  };

  const check = (label: string, v: boolean, set: (b: boolean) => void, hint: string) => (
    <label className="settings-check fm-check" title={hint}>
      <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );

  return (
    <div
      className="overlay modal-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal fm-dialog">
        <div className="modal-title">{t.fmTitle}</div>
        <label className="settings-label">
          {t.fmDocTitle}
          <input ref={titleRef} value={title} placeholder="3분기 보고서" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="settings-label">
          {t.fmAuthor}
          <input value={author} placeholder="홍길동" onChange={(e) => setAuthor(e.target.value)} />
        </label>
        <label className="settings-label">
          {t.fmDate}
          <input value={date} placeholder="2026-10-13" onChange={(e) => setDate(e.target.value)} />
        </label>
        <div className="fm-toggles">
          {check(t.fmToc, toc, setToc, t.fmTocHint)}
          {check(t.fmLof, lof, setLof, t.fmLofHint)}
          {check(t.fmLot, lot, setLot, t.fmLotHint)}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={save}>
            {t.save}
          </button>
          <button className="btn btn-plain" onClick={onClose}>
            {t.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
