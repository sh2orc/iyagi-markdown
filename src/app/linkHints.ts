// 링크 편집 자동완성 후보 — 문서 폴더 기준 상대 경로(파일·에셋).
// 순수 함수 — 스토어 스냅숏만 읽는다.

import type { AppStore } from "./store";
import type { TreeNode } from "../api";
import { relPath } from "../paths";

/** 문서 폴더(또는 워크스페이스 루트) 상대 파일 경로 최대 60개. */
export function pathHintsOf(store: AppStore): string[] {
  const tab = store.active;
  const base = tab?.path
    ? tab.path.substring(0, tab.path.lastIndexOf("/")) || "/"
    : store.state.workspace;
  if (!base) return [];
  const out: string[] = [];
  const walk = (nodes: TreeNode[], depth: number): void => {
    for (const n of nodes) {
      if (n.kind === "file") {
        const r = relPath(base, n.path);
        if (r && !r.startsWith("..")) out.push(r);
      } else if (depth < 2) {
        walk(n.children ?? [], depth + 1);
      }
    }
  };
  walk(store.state.tree, 0);
  return out.slice(0, 60);
}
