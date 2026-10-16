// 단축키 도움말 패널 — 도움말 › 키보드 단축키. 앱의 모든 단축키를 분야별로.

import { useEffect, useRef, useState } from "react";

import type { Translate } from "../i18n";
import { imeComposing } from "../app/ime";

interface Props {
  t: Translate;
  onClose: () => void;
}

const GROUPS = (t: Translate): Array<{ title: string; items: [string, string][] }> => [
  {
    title: t.scFile,
    items: [
      ["⌘N", t.newTab],
      ["⌘O", t.openFolder],
      ["⌘W", t.closeTab],
      ["⌘S", t.save],
      ["⇧⌘S", t.saveAs],
      ["⌘P", t.exportPdf],
    ],
  },
  {
    title: t.scView,
    items: [
      ["⌘E", `${t.modeRead} ↔ ${t.modeEdit}`],
      ["⌘/", t.modeSource],
      ["⇧⌘B", t.toggleSidebar],
      ["⇧⌘T", t.tocTitle],
      ["⌘F", t.findPlaceholder],
      ["[w", t.findWordHelp],
      ["⇧⌘F", t.wsSearchTitle],
      ["⌘G / ⇧⌘G", `${t.findNext ?? t.findPlaceholder} / ${t.findPrev ?? t.findPlaceholder}`],
      ["⌘+ / ⌘− / ⌘0", `${t.zoomIn} · ${t.zoomOut}`],
      ["⇧⌘] / ⇧⌘[", `${t.nextTab ?? t.tbBullet} / ${t.prevTab ?? t.tbBullet}`],
    ],
  },
  {
    title: t.scFormat,
    items: [
      ["⌘B", t.tbBold],
      ["⌥⌘C / ⌥⌘V", t.formatPainterHelp],
      ["⌥⌘⇧V", t.pastePlainHelp],
      ["⌘I", t.tbItalic],
      ["⇧⌘X", t.tbStrike],
      ["⌘⇧C", t.tbCode],
      ["⇧⌘H", t.tbHighlight],
      ["⇧⏎", t.hardBreak],
      ["⇧⌘↵", t.pageBreakHelp],
      ["⌥↑ / ⌥↓", t.scMoveLines],
      ["⌘D", t.scDuplicateLine],
      [`${t.keyAltClick} / ⌥⌘↑ / ⌥⌘↓`, t.scMultiCursor],
      ["⌥⌘D", t.scNextOccurrence],
      [t.keyAltDrag, t.scRectSelect],
      ["⇧F3", t.scCaseCycle],
      ["⌘J", t.scJoinLines],
      ["⌘⇧K", t.scDeleteLines],
    ],
  },
  {
    title: t.scEdit,
    items: [
      ["⌘Z / ⇧⌘Z", `${t.ctxUndo} · ${t.ctxRedo}`],
      [t.keyRightClick, `${t.ctxCut} · ${t.ctxPaste} · ${t.ctxSelectAll}`],
    ],
  },
  {
    title: t.scTable,
    items: [
      [t.keyDoubleClick, t.tbTable],
      [t.keyClick, t.cellClickEdit],
      [`${t.keyRightClick} · ⇧F10`, `${t.ctxAddRow} · ${t.ctxAlign}`],
      ["←↑↓→", t.helpCellMove],
      ["⇧←↑↓→", t.helpCellSelect],
      ["Enter / ⇧Enter", `${t.helpCellEdit} ↓·↑`],
      ["Tab / ⇧Tab", t.cellNavHelp],
    ],
  },
  {
    title: t.scMousePalette,
    items: [
      ["⌘⇧P + @", t.helpSymbolMode],
      ["c", t.brokenKeyCreate],
      [t.keyGutter, t.helpFold],
      [t.keyHover, t.helpWikiHover],
      ["←→↑↓", t.helpGraphNav],
      ["+/−/0", t.helpGraphZoom],
      ["뷰어 ←→/+−/0", t.helpViewerKeys],
      ["패널 ↑↓/⏎/Esc", t.helpPanelList],
      ["←→", t.helpResizer],
      ["⌘⇧P", `${t.speakStart} · ${t.speakStop}`],
    ],
  },
];

export function ShortcutsPanel({ t, onClose }: Props): JSX.Element {
  // 검색 — 키·설명 모두에서 대소문자 무시 부분 일치. 빈 값은 전체.
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const query = q.trim().toLowerCase();
  const match = (key: string, label: string): boolean =>
    !query || key.toLowerCase().includes(query) || label.toLowerCase().includes(query);
  const groups = GROUPS(t)
    .map((g) => ({ ...g, items: g.items.filter(([k, l]) => match(k, l)) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="overlay modal-overlay" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts-modal">
        <div className="modal-title">{t.shortcutsTitle}</div>
        <input
          ref={inputRef}
          className="palette-input sc-search"
          placeholder={t.tocFilter}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (imeComposing(e)) return; // IME 조합 중 키는 IME가 소비(한글 Esc·Enter 새기기 방지)
            if (e.key === "Escape") {
              e.preventDefault();
              if (q) setQ("");
              else onClose();
            }
          }}
        />
        {groups.length === 0 && <div className="palette-empty">{t.symbolNoMatch}</div>}
        <div className="shortcuts-grid">
          {groups.map((g) => (
            <section key={g.title} className="sc-group">
              <h3 className="sc-group-title">{g.title}</h3>
              <table className="sc-table">
                <tbody>
                  {g.items.map(([key, label]) => (
                    <tr key={key + label}>
                      <td className="sc-key">{key}</td>
                      <td className="sc-label">{label}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            {t.done}
          </button>
        </div>
      </div>
    </div>
  );
}
