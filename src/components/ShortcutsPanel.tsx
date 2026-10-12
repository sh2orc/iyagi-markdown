// 단축키 도움말 패널 — 도움말 › 키보드 단축키. 앱의 모든 단축키를 분야별로.

import type { Translate } from "../i18n";

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
      ["⌘I", t.tbItalic],
      ["⇧⌘X", t.tbStrike],
      ["⌘⇧C", t.tbCode],
      ["⇧⏎", t.hardBreak],
      ["⌥↑ / ⌥↓", t.scMoveLines],
      ["⌘D", t.scDuplicateLine],
      ["⌘⇧K", t.scDeleteLines],
    ],
  },
  {
    title: t.scEdit,
    items: [
      ["⌘Z / ⇧⌘Z", `${t.ctxUndo} · ${t.ctxRedo}`],
      ["우클릭", `${t.ctxCut} · ${t.ctxPaste} · ${t.ctxSelectAll}`],
    ],
  },
  {
    title: t.scTable,
    items: [
      ["더블클릭", t.tbTable],
      ["우클릭", `${t.ctxAddRow} · ${t.ctxAlign}`],
    ],
  },
  {
    title: t.scMousePalette,
    items: [
      ["⌘⇧P + @", t.helpSymbolMode],
      ["거터 ▾", t.helpFold],
      ["호버", t.helpWikiHover],
      ["⌘⇧P", `${t.speakStart} · ${t.speakStop}`],
    ],
  },
];

export function ShortcutsPanel({ t, onClose }: Props): JSX.Element {
  return (
    <div className="overlay modal-overlay" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal shortcuts-modal">
        <div className="modal-title">{t.shortcutsTitle}</div>
        <div className="shortcuts-grid">
          {GROUPS(t).map((g) => (
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
