// 데일리 노트 — 날짜 제목(로컬), 트리 탐색(루트 우선), 시작 내용.
import { describe, expect, it } from "vitest";
import { dailyNoteContent, dailyNoteTitle, findDailyNote } from "./dailyNote";
import type { TreeNode } from "../api";

const file = (name: string, path: string): TreeNode =>
  ({ kind: "file", name, stem: name.replace(/\.md$/, ""), path });
const dir = (name: string, path: string, children: TreeNode[]): TreeNode =>
  ({ kind: "dir", name, path, children });

describe("dailyNoteTitle", () => {
  it("로컬 날짜 YYYY-MM-DD — UTC 자정 교차(한국 자정~9시)에도 하루 안 늦는다", () => {
    expect(dailyNoteTitle(new Date(2026, 9, 24, 0, 30))).toBe("2026-10-24"); // 한국 자정 직후
    expect(dailyNoteTitle(new Date(2026, 0, 1, 23, 59))).toBe("2026-01-01"); // 연초 경계
    expect(dailyNoteTitle(new Date(2026, 11, 31, 12))).toBe("2026-12-31");
  });
});

describe("findDailyNote", () => {
  const tree: TreeNode[] = [
    dir("sub", "/w/sub", [file("2026-10-24.md", "/w/sub/2026-10-24.md")]),
    file("2026-10-23.md", "/w/2026-10-23.md"),
  ];
  it("루트의 오늘 문서 우선, 없으면 깊은 첫 번째", () => {
    const withRoot: TreeNode[] = [file("2026-10-24.md", "/w/2026-10-24.md"), ...tree];
    expect(findDailyNote(withRoot, "2026-10-24")).toBe("/w/2026-10-24.md");
    expect(findDailyNote(tree, "2026-10-24")).toBe("/w/sub/2026-10-24.md");
    expect(findDailyNote(tree, "2026-10-23")).toBe("/w/2026-10-23.md");
    expect(findDailyNote(tree, "2026-10-25")).toBeNull();
  });
});

describe("dailyNoteContent", () => {
  it("제목과 오늘 섹션 — ko/en", () => {
    expect(dailyNoteContent("2026-10-24")).toContain("# 2026-10-24");
    expect(dailyNoteContent("2026-10-24")).toContain("오늘의 기록");
    expect(dailyNoteContent("2026-10-24", "en")).toContain("## Today");
  });
});
