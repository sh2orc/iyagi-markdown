// 끊긴 링크 패널 — [[위키링크]]·[파일](rel)·![이미지](rel) 중 대상이 없는 것
// (Obsidian "broken links"). 클릭하면 해당 줄로.

import { useEffect, useMemo, useRef, useState } from "react";

import type { AppStore } from "../app/store";
import type { TreeNode } from "../api";
import { brokenFileLinks, brokenWikiLinks } from "../editor/brokenLinks";
import { resolveWikiLink } from "../editor/wiki";
import { stripFrontMatter } from "../editor/frontmatter";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onGoto: (from: number) => void;
  /** 끊긴 이름으로 새 문서 생성(워크스페이스 루트) 후 연다. */
  onCreate: (name: string) => void;
}

export function BrokenLinksPanel({ store, t, onClose, onGoto, onCreate }: Props): JSX.Element {
  const tab = store.active;
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 오버레이 자체 포커스 — 키보드 탐색(백링크 패널과 같은 규칙).
    listRef.current?.parentElement?.focus();
  }, []);

  useEffect(() => {
    setSel(0);
  }, [tab?.path]);

  const noWorkspace = !store.state.workspace;

  const broken = useMemo(() => {
    // 워크스페이스가 없으면 인덱스가 비어 모든 링크가 '끊김'으로 나온다 —
    // 검사하지 않고 안내로 대체(오진 방지).
    if (!tab || noWorkspace) return [];
    const text = tab.state.doc.toString();
    const dir = tab.path ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/" : "";
    // 프론트매터의 태그 등은 제외 — 본문만 검사.
    const offset = text.length - stripFrontMatter(text).length;
    // 트리 파일 집합 — 상대 링크·이미지 존재 판정.
    const fileSet = new Set<string>();
    const walkTree = (nodes: TreeNode[]): void => {
      for (const n of nodes) {
        fileSet.add(n.path);
        if (n.kind === "dir") walkTree(n.children ?? []);
      }
    };
    walkTree(store.state.tree);
    const wiki = brokenWikiLinks(stripFrontMatter(text), (name) =>
      resolveWikiLink(name, dir, store.wikiIndex),
    );
    const files = brokenFileLinks(stripFrontMatter(text), (p) => fileSet.has(p), dir);
    return [...wiki, ...files].map((b) => ({ ...b, from: b.from + offset }));
  }, [tab, tab?.state.doc, store.wikiIndex, store.state.tree]);

  useEffect(() => {
    setSel(0);
  }, [tab?.path]);

  const step = (from: number, delta: number): number => {
    let i = from;
    for (;;) {
      const next = i + delta;
      if (next < 0 || next >= broken.length) return i;
      i = next;
    }
  };

  return (
    <div
      className="overlay palette-overlay"
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSel((v) => step(v, 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSel((v) => step(v, -1));
        } else if (e.key === "Enter") {
          e.preventDefault();
          const b = broken[sel];
          if (b) {
            onClose();
            onGoto(b.from);
          }
        } else if (e.key.toLowerCase() === "c") {
          const b = broken[sel];
          if (b) {
            e.preventDefault();
            onCreate(b.name);
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette wssearch">
        <div className="palette-input palette-input-static">
          {t.brokenLinksTitle}
          {broken.length > 0 && <span className="wssearch-count">{broken.length}</span>}
        </div>
        <div className="palette-list" ref={listRef}>
          {broken.length === 0 && (
            <div className="palette-empty">{noWorkspace ? t.wsSearchNoFolder : t.brokenLinksNone}</div>
          )}
          {broken.map((b, i) => (
            <button
              key={`${b.from}-${b.name}`}
              className={`palette-item wssearch-hit ${i === sel ? "is-sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => {
                onClose();
                onGoto(b.from);
              }}
            >
              <span className="wssearch-lineno">{b.line}</span>
              <span className="wssearch-text">
                [[<mark className="wssearch-mark">{b.name}</mark>]]
              </span>
              <span
                className="broken-create"
                title={t.brokenCreate}
                onClick={(e) => {
                  e.stopPropagation();
                  onCreate(b.name);
                }}
              >
                ＋
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
