// 단축키 도움말 패널 — 도움말 › 키보드 단축키. 앱의 모든 단축키를 분야별로.

import { useEffect, useRef, useState } from "react";

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
      ["클릭", t.cellClickEdit],
      ["우클릭", `${t.ctxAddRow} · ${t.ctxAlign}`],
      ["Tab / ⇧Tab", t.cellNavHelp],
    ],
  },
  {
    title: t.scMousePalette,
    items: [
      ["⌘⇧P + @", t.helpSymbolMode],
      ["c", t.brokenKeyCreate],
      ["거터 ▾", t.helpFold],
      ["호버", t.helpWikiHover],
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
