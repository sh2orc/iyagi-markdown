// 데일리 노트 — 오늘 날짜 문서를 열거나 만든다(Obsidian daily-notes 관례).
// 날짜는 로컬 시간(templates.ts 교훈 — toISOString은 UTC라 한국 자정~9시가
// 하루 늦는다). 순수 함수(테스트 대상).

import type { TreeNode } from "../api";

/** 오늘 제목(YYYY-MM-DD, 로컬 시간). */
export function dailyNoteTitle(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 데일리 노트 시작 내용 — 제목 하나(나머지는 사용자가). */
export function dailyNoteContent(title: string, lang: "ko" | "en" = "ko"): string {
  return `# ${title}\n\n${lang === "ko" ? "## 오늘의 기록\n" : "## Today\n"}`;
}

/** 트리에서 데일리 노트 경로 찾기 — 루트 우선, 깊으면 첫 번째. */
export function findDailyNote(tree: TreeNode[], title: string): string | null {
  const target = `${title}.md`.toLowerCase();
  let found: string | null = null;
  let atRoot: string | null = null;
  const walk = (nodes: TreeNode[], root: boolean) => {
    for (const n of nodes) {
      if (n.kind === "dir") walk(n.children ?? [], false);
      else if (n.name.toLowerCase() === target) {
        if (root) atRoot = n.path;
        else if (!found) found = n.path;
      }
    }
  };
  walk(tree, true);
  return atRoot ?? found;
}
