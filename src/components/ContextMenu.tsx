// 에디터 우클릭 메뉴(Word 컨텍스트 메뉴) — 기본 웹뷰 메뉴을 대체한다.
// 편집·서식·링크·표 명령. 모두 원문 텍스트 편집 또는 클립보드 API로 동작.

import { useEffect, useRef, useState } from "react";
import { redo, undo } from "@codemirror/commands";

import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";
import * as fmt from "../editor/format";
import { findLinkAt } from "../editor/livePreview";
import { previewConfigField } from "../editor/livePreview";

interface Props {
  store: AppStore;
  t: Translate;
}

interface MenuState {
  x: number;
  y: number;
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  inTable: boolean;
  link: { url: string; baseDir: string } | null;
}

export function ContextMenu({ store, t }: Props): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onContext = (e: MouseEvent) => {
      const host = (e.target as HTMLElement | null)?.closest?.(".editor-host");
      const view = store.view;
      if (!host || !view) return;
      e.preventDefault();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      const sel = view.state.selection.main;
      const link = pos == null ? null : findLinkAt(view.state, pos);
      const baseDir = view.state.field(previewConfigField, false)?.baseDir ?? "";
      setMenu({
        x: e.clientX,
        y: e.clientY,
        hasSelection: !sel.empty,
        // undo/redo 깊이는 비공개 API라 항상 활성(실행 시 없으면 무동작).
        canUndo: editableNow(store),
        canRedo: editableNow(store),
        inTable: pos != null && !!fmt.tableAround(view),
        link: link ? { url: link.url, baseDir } : null,
      });
    };
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("contextmenu", onContext);
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [store]);

  if (!menu) return null;

  const view = store.view;
  if (!view) return null;
  const tab = store.active;
  const editable = tab?.mode !== "read";

  // 화면 오른쪽/아래로 넘치지 않게.
  const style: React.CSSProperties = {
    left: Math.min(menu.x, window.innerWidth - 230),
    top: Math.min(menu.y, window.innerHeight - 340),
  };

  const run = (fn: () => void) => {
    setMenu(null);
    fn();
    view.focus();
  };

  const sel = view.state.selection.main;
  const selText = sel.empty ? "" : view.state.sliceDoc(sel.from, sel.to);

  const copySel = () =>
    run(() => {
      void navigator.clipboard?.writeText(selText).catch(() => {});
    });
  const cutSel = () =>
    run(() => {
      void navigator.clipboard?.writeText(selText).catch(() => {});
      view.dispatch({ changes: { from: sel.from, to: sel.to } });
    });
  const pasteClip = () =>
    run(() => {
      navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) view.dispatch({ changes: { from: sel.from, to: sel.to, insert: text } });
        })
        .catch(() => store.toast(t.ctxPasteBlocked, "error"));
    });

  const openLink = () =>
    run(() => {
      const target = menu.link!;
      void import("@tauri-apps/plugin-opener").then((opener) =>
        opener.openUrl(target.url).catch(() => {}),
      );
      void target.baseDir;
    });
  const copyLink = () =>
    run(() => {
      void navigator.clipboard?.writeText(menu.link!.url).catch(() => {});
      store.toast(t.linkCopy);
    });

  const item = (label: string, fn: () => void, opts?: { disabled?: boolean; danger?: boolean; sepAfter?: boolean }) => (
    <button
      key={label}
      className={`ctx-item ${opts?.danger ? "is-danger" : ""}`}
      disabled={opts?.disabled}
      onClick={fn}
    >
      {label}
    </button>
  );

  return (
    <div ref={menuRef} className="ctx-menu" style={style} onContextMenu={(e) => e.preventDefault()}>
      {menu.link && item(t.ctxOpenLink, openLink)}
      {menu.link && item(t.ctxCopyLink, copyLink)}
      {menu.link && <span className="ctx-sep" />}
      {item(t.ctxUndo, () => run(() => undo(view)), { disabled: !menu.canUndo || !editable })}
      {item(t.ctxRedo, () => run(() => redo(view)), { disabled: !menu.canRedo || !editable })}
      <span className="ctx-sep" />
      {item(t.ctxCut, cutSel, { disabled: !menu.hasSelection })}
      {item(t.ctxCopy, copySel, { disabled: !menu.hasSelection })}
      {item(t.ctxPaste, pasteClip, { disabled: !editable })}
      {item(t.ctxSelectAll, () => run(() => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })))}
      {editable && menu.hasSelection && (
        <>
          <span className="ctx-sep" />
          {item(`**${t.tbBold}**`, () => run(() => fmt.toggleBold(view)))}
          {item(`*${t.tbItalic}*`, () => run(() => fmt.toggleItalic(view)))}
          {item(`\`${t.tbCode}\``, () => run(() => fmt.toggleInlineCode(view)))}
        </>
      )}
      {editable && tab?.path && (
        <>
          <span className="ctx-sep" />
          {item(
            store.active?.bookmarks.includes(menuLine(store)) ? t.ctxRemoveBookmark : t.ctxAddBookmark,
            () => run(() => store.toggleBookmark()),
          )}
        </>
      )}
      {editable && menu.inTable && (
        <>
          <span className="ctx-sep" />
          {item(t.ctxAddRow, () => run(() => fmt.tableAddRow(view)))}
          {item(t.ctxAddCol, () => run(() => fmt.tableAddColumn(view)))}
          {item(t.ctxDelRow, () => run(() => fmt.tableDeleteRow(view)))}
          {item(t.ctxDelCol, () => run(() => fmt.tableDeleteColumn(view)))}
          <span className="ctx-sep" />
          {item(`⬅ ${t.ctxAlign}: ${t.alignLeft}`, () => run(() => fmt.tableAlignColumn(view, "left")))}
          {item(`↔ ${t.ctxAlign}: ${t.alignCenter}`, () => run(() => fmt.tableAlignColumn(view, "center")))}
          {item(`➡ ${t.ctxAlign}: ${t.alignRight}`, () => run(() => fmt.tableAlignColumn(view, "right")))}
          {item(t.alignNone, () => run(() => fmt.tableAlignColumn(view, "none")))}
        </>
      )}
    </div>
  );
}

function editableNow(store: AppStore): boolean {
  return store.active?.mode !== "read";
}

/** 우클릭한 줄 번호. */
function menuLine(store: AppStore): number {
  const v = store.view;
  if (!v) return 1;
  return v.state.doc.lineAt(v.state.selection.main.head).number;
}
