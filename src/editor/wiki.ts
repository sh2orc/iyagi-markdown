// 위키링크 [[이름|표시]] / [[이름#앵커]] — lezer 인라인 확장 + 해석 순수 유틸
// (Obsidian 문법). 표시는 livePreview 위젯, 클릭은 cm의 링크 처리가 절대
// 경로로 넘겨 markdown 분류시켜 연다. 파일 존재 확인은 파일시스템이 아니라
// 워크스페이스 트리로(store가 인덱스를 만들어 프리뷰 설정에 실어 보낸다).

import type { MarkdownExtension } from "@lezer/markdown";

import type { TreeNode } from "../api";
import { relPath } from "../paths";
import { slugifyHeading } from "../links";

export const wikiLinkSyntax: MarkdownExtension = {
  defineNodes: [{ name: "WikiLink" }],
  parseInline: [
    {
      name: "iyagiWikiLink",
      before: "Link",
      parse(cx, next, pos) {
        // [[ 로 시작해 같은 줄에서 ]]로 닫힌다. [x] 한 겹은 일반 링크/각주 몫.
        if (next !== 0x5b /* [ */ || cx.char(pos + 1) !== 0x5b) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 0x0a) return -1; // 줄을 넘지 않는다
          if (c === 0x5d /* ] */) {
            if (cx.char(i + 1) !== 0x5d) return -1;
            if (i <= pos + 2) return -1; // [[]] 빈 이름 아님
            return cx.addElement(cx.elt("WikiLink", pos, i + 2));
          }
        }
        return -1;
      },
    },
  ],
};

/** [[이름#앵커|표시]] 분해 — 이름의 \는 /로(Windows식 구분자 관대 처리). */
export function parseWikiLink(raw: string): {
  name: string;
  anchor: string | null;
  display: string | null;
} {
  const body = raw.slice(2, -2);
  const bar = body.indexOf("|");
  const target = (bar >= 0 ? body.slice(0, bar) : body).trim();
  const display = bar >= 0 ? body.slice(bar + 1).trim() || null : null;
  const hash = target.indexOf("#");
  const name = (hash >= 0 ? target.slice(0, hash) : target).replace(/\\/g, "/").trim();
  const anchor = hash >= 0 ? target.slice(hash + 1).trim() || null : null;
  return { name, anchor, display };
}

/** 트리 → 위키링크 인덱스: key(소문자) → 경로들(도달 순).
 *  key는 stem 과 상대경로/stem 두 종류(`[[note]]`, `[[folder/note]]`). */
export function buildWikiIndex(tree: TreeNode[]): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  const add = (key: string, path: string) => {
    const k = key.toLowerCase();
    const arr = idx.get(k);
    if (arr) arr.push(path);
    else idx.set(k, [path]);
  };
  const walk = (nodes: TreeNode[], dir: string) => {
    for (const n of nodes) {
      if (n.kind === "dir") {
        walk(n.children ?? [], dir ? `${dir}/${n.name}` : n.name);
      } else {
        const stem = n.stem ?? n.name.replace(/\.(md|markdown)$/i, "");
        add(stem, n.path);
        if (dir) add(`${dir}/${stem}`, n.path);
      }
    }
  };
  walk(tree, "");
  return idx;
}

/** 이름 해석 — 같은 디렉터리 우선, 그다음 도달 순 첫 번째. 없으면 null. */
export function resolveWikiLink(name: string, docDir: string, index: Map<string, string[]>): string | null {
  if (!name) return null;
  const cands = index.get(name.toLowerCase());
  if (!cands || cands.length === 0) return null;
  const same = cands.find((p) => p.slice(0, p.lastIndexOf("/")) === docDir);
  return same ?? cands[0];
}

/** 내보내기용: [[..]]를 마크다운 링크로 바꾼다. resolve는 이름→절대 경로
 *  (없으면 null → 이름.md 상대 참조로 둔다). 앵커는 제목 슬러그로. */
export function wikiLinksToMarkdown(
  text: string,
  resolve: (name: string) => string | null,
  docDir: string,
): string {
  return text.replace(/\[\[([^\]\n]+)\]\]/g, (whole, inner: string) => {
    if (inner.trim().startsWith("^")) return whole; // 블록 참조(^id)는 그대로
    const { name, anchor, display } = parseWikiLink(`[[${inner}]]`);
    if (!name) return whole;
    const abs = resolve(name);
    const href = abs ? relPath(docDir, abs) : `${name}.md`;
    const label = display ?? name;
    const frag = anchor ? `#${slugifyHeading(anchor)}` : "";
    return `[${label}](${href}${frag})`;
  });
}
