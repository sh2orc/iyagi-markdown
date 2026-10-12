// 빠른 열기(팔레트 파일 모드) 순수 로직 — 컴포넌트 없이 단위 테스트한다.
// 최근 문서가 워크스페이스 트리보다 앞에 온다(빈 쿼리에서 최근순 표시).

import type { TreeNode } from "../api";

export interface FileEntry {
  path: string;
  name: string;
  /** 구분 표시용 디렉터리 — 워크스페이스 루트 기준 상대 경로(루트 밖은 전체). */
  rel: string;
}

/** 서브시쿼스 퍼지 매칭 — 연속 매치에 가중치. -1 = 탈락. */
export function subsequence(query: string, text: string): number {
  if (!query) return 1;
  let qi = 0;
  let score = 0;
  const hay = text.toLowerCase();
  for (const ch of query.toLowerCase()) {
    const idx = hay.indexOf(ch, qi);
    if (idx === -1) return -1;
    score += idx === qi ? 2 : 1;
    qi = idx + 1;
  }
  return score;
}

/** 최근 문서 + 워크스페이스 트리를 평면 파일 목록으로. 경로 중복은 최근이 이긴다. */
export function flattenFiles(
  recent: { path: string; name: string }[],
  tree: TreeNode[] | null,
  root: string | null,
  cap = 4000,
): FileEntry[] {
  const out: FileEntry[] = [];
  const seen = new Set<string>();
  const relOf = (path: string): string => {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (root && dir === root) return "";
    return root && dir.startsWith(root + "/") ? dir.slice(root.length + 1) : dir;
  };
  for (const r of recent) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    out.push({ path: r.path, name: r.name, rel: relOf(r.path) });
  }
  if (tree) {
    const walk = (nodes: TreeNode[], dir: string) => {
      for (const n of nodes) {
        if (n.kind === "dir") {
          walk(n.children ?? [], dir ? `${dir}/${n.name}` : n.name);
        } else if (!seen.has(n.path)) {
          seen.add(n.path);
          out.push({ path: n.path, name: n.name, rel: dir });
        }
      }
    };
    walk(tree, "");
  }
  return out.length > cap ? out.slice(0, cap) : out;
}

/** 이름 매치가 경로 매치보다 2배(파일명이 본체), 이름 접두사 매치에 보너스. */
export function scoreFile(query: string, f: FileEntry): number {
  const q = query.trim();
  if (!q) return 1;
  const sName = subsequence(q, f.name);
  const sRel = subsequence(q, f.rel);
  if (sName < 0 && sRel < 0) return -1;
  let s = Math.max(sName < 0 ? 0 : sName * 2, sRel);
  if (f.name.toLowerCase().startsWith(q.toLowerCase())) s += 4;
  return s;
}
