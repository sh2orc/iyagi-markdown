// 선택 미니 서식 바(Word 시그니처) — 텍스트를 선택하면 선택 영역 위에 뜬다.
// 모든 동작은 원문 텍스트 편집(§4-1). 스크롤하면 접히고 다음 선택에 다시 뜬다.

import { useEffect, useRef, useState } from "react";

import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import * as fmt from "../editor/format";
import { LinkDialog } from "./LinkDialog";
import { findLinkAt } from "../editor/livePreview";

interface Props {
  store: AppStore;
  t: Translate;
}

export function MiniToolbar({ store, t }: Props): JSX.Element | null {
  const state = store.getSnapshot();
  const view = store.view;
  const tab = state.tabs.find((x) => x.id === state.activeId) ?? null;
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** 링크 편집 대화상자 위치(커서가 링크 안일 때 ✎). */
  const [linkEditPos, setLinkEditPos] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);

  // 스크롤에는 접힌다(위치가 어긋나 보이는 것보다 낫다) — 다음 선택에서 재등장.
  useEffect(() => {
    if (!view) return;
    const hide = () => setHidden(true);
    view.scrollDOM.addEventListener("scroll", hide, { passive: true });
    return () => view.scrollDOM.removeEventListener("scroll", hide);
  }, [view]);

  // 선택이 바뀔 때마다 다시 보이게.
  useEffect(() => {
    setHidden(false);
  }, [tab?.marks, state.activeId]);

  const sel = view?.state.selection.main;
  const canShow =
    !hidden && view && tab && tab.mode === "edit" && sel && !sel.empty && sel.to > sel.from;

  if (!canShow || !sel || !view || !tab) return null;

  let pos: { top: number; left: number } | null = null;
  try {
    const a = view.coordsAtPos(sel.from);
    const b = view.coordsAtPos(sel.to);
    const host = hostRef.current?.parentElement;
    if (a && b && host) {
      const rect = host.getBoundingClientRect();
      pos = {
        top: Math.min(a.top, b.top) - rect.top - 44,
        left: (Math.min(a.left, b.left) + Math.max(a.right ?? a.left, b.right ?? b.left)) / 2 - rect.left,
      };
      // 선택이 화면 위로 걸치면 아래로.
      if (pos.top < 4) {
        pos = {
          top: Math.max(a.bottom, b.bottom) - rect.top + 10,
          left: pos.left,
        };
      }
    }
  } catch {
    pos = null;
  }
  if (!pos) return null;

  const run = (fn: (v: NonNullable<typeof view>) => boolean) => {
    if (view) {
      // 잠긴 문서는 서식 명령도 차단(144차 일관성).
      if (!view.state.readOnly) fn(view);
      view.focus();
    }
  };

  return (
    <>
    <div ref={hostRef} className="mini-tb" style={{ top: pos.top, left: pos.left }}>
      <button className="mtb-btn" title={t.tbBold} onMouseDown={(e) => e.preventDefault()} onClick={() => run(fmt.toggleBold)}>
        <b>B</b>
      </button>
      <button className="mtb-btn" title={t.tbItalic} onMouseDown={(e) => e.preventDefault()} onClick={() => run(fmt.toggleItalic)}>
        <i>I</i>
      </button>
      <button className="mtb-btn" title={t.tbStrike} onMouseDown={(e) => e.preventDefault()} onClick={() => run(fmt.toggleStrikethrough)}>
        <s>S</s>
      </button>
      <button className="mtb-btn" title={`${t.tbHighlight} (⇧⌘H)`} onMouseDown={(e) => e.preventDefault()} onClick={() => run(fmt.toggleHighlight)}>
        <span className="tb-mark">▤</span>
      </button>
      <button className="mtb-btn" title={t.tbCode} onMouseDown={(e) => e.preventDefault()} onClick={() => run(fmt.toggleInlineCode)}>
        <span className="tb-mono">{"</>"}</span>
      </button>
      <button className="mtb-btn" title={t.tbLink} onMouseDown={(e) => e.preventDefault()} onClick={() => run((v) => fmt.insertLink(v))}>
        🔗
      </button>
      {tab?.marks.link && (
        <button className="mtb-btn" title={t.ctxEditLink} onClick={() => setLinkEditPos(pos ? view!.state.selection.main.from : null)}>
          ✎
        </button>
      )}
      <span className="mtb-sep" />
      <button className="mtb-btn" title={t.tbBullet} onMouseDown={(e) => e.preventDefault()} onClick={() => run(fmt.toggleBulletList)}>
        •—
      </button>
      <button className="mtb-btn" title={`${t.tbHeading} 1`} onMouseDown={(e) => e.preventDefault()} onClick={() => run((v) => fmt.toggleHeading(v, 1))}>
        <b>H1</b>
      </button>
      <button className="mtb-btn" title={`${t.tbHeading} 2`} onMouseDown={(e) => e.preventDefault()} onClick={() => run((v) => fmt.toggleHeading(v, 2))}>
        <b>H2</b>
      </button>
      <button className="mtb-btn" title={t.tbQuote} onMouseDown={(e) => e.preventDefault()} onClick={() => run(fmt.toggleQuote)}>
        ❝
      </button>
    </div>
    {linkEditPos !== null && (() => {
      const v = view;
      if (!v) return null;
      const link = findLinkAt(v.state, linkEditPos);
      if (!link) return null;
      return (
        <LinkDialog
          initial={{ text: link.text, url: link.url, from: link.from, to: link.to }}
          t={t}
          onCancel={() => setLinkEditPos(null)}
          onConfirm={(next) => {
            setLinkEditPos(null);
            v.dispatch({
              changes: { from: link.from, to: link.to, insert: `[${next.text}](${next.url})` },
              userEvent: "input.editLink",
            });
            v.focus();
          }}
        />
      );
    })()}
    </>
  );
}
