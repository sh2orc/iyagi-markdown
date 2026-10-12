// 해시태그(#태그) — 인식·추출·완성. 원문은 텍스트 그대로(§4-1).
// 문법 규칙(Obsidian 호환): # 뒤에 공백 없이 시작하고, 한글·영문·숫자·_-/
// 를 태그 문자로 인정. 앞이 공백·줄 시작이어야 하고, # 뒤 첫 글자는 숫자만
// 안 된다(#123 아님, #v2는 됨). 줄 첫 #은 ATX 제목이므로 제외.

import type { TreeNode } from "../api";

export interface TagInfo {
  tag: string;
  /** 문서 내 출현 오프셋들. */
  positions: number[];
}

/** 문서에서 태그 추출 — 순수 함수(단위 테스트 대상). */
export function extractTags(text: string): TagInfo[] {
  const map = new Map<string, number[]>();
  const lines = text.split("\n");
  let pos = 0;
  let inFence = false;
  for (const line of lines) {
    const lineStart = pos;
    pos += line.length + 1;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 한 줄 안에서: 경계(공백/줄 시작) 뒤 # + 태그 문자들.
    const re = /(^|\s)#([\p{L}\p{N}_\-\/]+)/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const name = m[2];
      // 첫 글자가 숫자면 태그 아님(#1st).
      if (/^\p{N}/u.test(name)) continue;
      // 제목 줄(# 제목)은 첫 #만 있고 태그 문자 뒤 공백 — 위 정규식이 이미 걸러냄.
      const at = lineStart + m.index + m[1].length;
      const arr = map.get(name) ?? [];
      arr.push(at);
      map.set(name, arr);
    }
  }
  return [...map.entries()]
    .map(([tag, positions]) => ({ tag, positions }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

/** 트리 전체에서 태그 → 문서 경로 목록(워크스페이스 태그 색인). 문서 읽기는 호출자가. */
export interface TagIndexEntry {
  tag: string;
  paths: string[];
}

/** 문서별 태그 목록(경로 → 태그들)로 색인 구축. */
export function buildTagIndex(docTags: Array<{ path: string; tags: string[] }>): TagIndexEntry[] {
  const map = new Map<string, string[]>();
  for (const { path, tags } of docTags) {
    for (const t of tags) {
      const arr = map.get(t) ?? [];
      arr.push(path);
      map.set(t, arr);
    }
  }
  return [...map.entries()]
    .map(([tag, paths]) => ({ tag, paths }))
    .sort((a, b) => b.paths.length - a.paths.length || a.tag.localeCompare(b.tag));
}

/** 트리에서 .md 경로만 모으기(색인 수집용). */
export function markdownPaths(tree: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]): void => {
    for (const n of nodes) {
      if (n.kind === "dir") walk(n.children ?? []);
      else if (n.kind === "file") out.push(n.path);
    }
  };
  walk(tree);
  return out;
}
