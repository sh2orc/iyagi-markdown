// 위키링크 [[이름|표시]] / [[이름#앵커]] — lezer 인라인 확장 + 해석 순수 유틸
// (Obsidian 문법). 표시는 livePreview 위젯, 클릭은 cm의 링크 처리가 절대
// 경로로 넘겨 markdown 분류시켜 연다. 파일 존재 확인은 파일시스템이 아니라
// 워크스페이스 트리로(store가 인덱스를 만들어 프리뷰 설정에 실어 보낸다).

import type { MarkdownExtension } from "@lezer/markdown";

import type { TreeNode } from "../api";
import { relPath } from "../paths";
import { slugifyHeading } from "../links";

export const wikiLinkSyntax: MarkdownExtension = {
  defineNodes: [{ name: "WikiLink" }, { name: "Embed", style: {} }],
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
    {
      // 노트 임베드 ![[이름]] — 같은 줄에서 닫히는 위키링크의 느낌표 형태.
      // 기본 파서는 이것을 Image로 삼키므로 Link 규칙보다 먼저 가로챈다.
      name: "iyagiEmbed",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 0x21 /* ! */ || cx.char(pos + 1) !== 0x5b || cx.char(pos + 2) !== 0x5b) return -1;
        for (let i = pos + 3; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 0x0a) return -1;
          if (c === 0x5d /* ] */) {
            if (cx.char(i + 1) !== 0x5d) return -1;
            if (i <= pos + 3) return -1; // ![[ ]] 빈 이름 아님
            return cx.addElement(cx.elt("Embed", pos, i + 2));
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
        // 루트 기준 파일명은 동명 문서·확장자 충돌을 명시적으로 구별한다.
        add(`/${dir ? `${dir}/` : ""}${n.name}`, n.path);
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

/** 노트 임베드 ![[이름]] 인라인 — 내보내기에서 대상 문서 원문을 끌어 넣는다.
 *  깊이 4·순환 방지(Obsidian embedDepth 관례). 읽기 실패·순환이면 원문 그대로.
 *  read는 절대 경로 → 원문(null = 못 읽음). 재귀 결과에는 위키링크 변환이
 *  이어서 적용되므로 임베드 안의 [[..]]도 같이 해석된다. */
export async function inlineEmbeds(
  text: string,
  resolve: (name: string) => string | null,
  read: (path: string) => Promise<string | null>,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): Promise<string> {
  const matches = [...text.matchAll(/!\[\[([^\]\n]+)\]\]/g)];
  const out: string[] = [];
  let cursor = 0;
  for (const m of matches) {
    out.push(text.slice(cursor, m.index));
    cursor = m.index + m[0].length;
    if (depth >= 4) {
      out.push(m[0]); // 깊이 상한 — 원문 보존
      continue;
    }
    const inner = m[1];
    if (inner.trim().startsWith("^")) {
      out.push(m[0]); // 블록 참조는 그대로
      continue;
    }
    const { name } = parseWikiLink(`[[${inner}]]`);
    const abs = name ? resolve(name) : null;
    if (!abs || seen.has(abs)) {
      out.push(m[0]); // 없거나 순환 — 원문 보존
      continue;
    }
    const raw = await read(abs);
    if (raw == null) {
      out.push(m[0]);
      continue;
    }
    const body = stripFrontMatterForExport(raw);
    const nextSeen = new Set(seen);
    nextSeen.add(abs);
    out.push(await inlineEmbeds(body, resolve, read, depth + 1, nextSeen));
  }
  out.push(text.slice(cursor));
  return out.join("");
}

function stripFrontMatterForExport(text: string): string {
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---\n", 4);
  return end >= 0 ? text.slice(end + 5) : text;
}

/** 내보내기용: [[..]]를 마크다운 링크로 바꾼다. resolve는 이름→절대 경로
 *  (없으면 null → 이름.md 상대 참조로 둔다). 앵커는 제목 슬러그로. */
export function wikiLinksToMarkdown(
  text: string,
  resolve: (name: string) => string | null,
  docDir: string,
): string {
  // ![[이름]](노트 임베드)은 건드리지 않는다 — 이미지로 오변환되기 전에
  // 임베드 인라인(inlineEmbeds)이 먼저 처리한다(?<!! 룩비하인드).
  return text.replace(/(?<!!)\[\[([^\]\n]+)\]\]/g, (whole, inner: string) => {
    if (inner.trim().startsWith("^")) return whole; // 블록 참조(^id)는 그대로
    const { name, anchor, display } = parseWikiLink(`[[${inner}]]`);
    if (!name) return whole;
    const abs = resolve(name);
    // CommonMark 링크 목적지엔 공백·짝 안 맞는 괄호가 못 들어간다 — 파일명에
    // "my note.md"가 있으면 [x](my note.md)는 링크가 깨진다. 퍼센트 인코딩.
    const href = (abs ? relPath(docDir, abs) : `${name}.md`).replace(/[ ()]/g, (c) =>
      c === " " ? "%20" : c === "(" ? "%28" : "%29",
    );
    const label = display ?? name;
    const frag = anchor ? `#${slugifyHeading(anchor)}` : "";
    return `[${label}](${href}${frag})`;
  });
}
