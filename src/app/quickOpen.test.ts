// 빠른 열기(팔레트 파일 모드) 순수 로직 테스트 — 최근 우선·중복 제거·
// 상대 경로·이름/경로 퍼지 가중치의 정확성이 퀵 스위처 신뢰성의 전부다.

import { describe, expect, it } from "vitest";

import type { TreeNode } from "../api";
import { flattenFiles, scoreFile, subsequence } from "./quickOpen";

const tree: TreeNode[] = [
  {
    kind: "dir",
    name: "notes",
    path: "/w/notes",
    children: [
      { kind: "file", name: "todo.md", path: "/w/notes/todo.md" },
      { kind: "file", name: "meeting.md", path: "/w/notes/meeting.md" },
      {
        kind: "dir",
        name: "arch",
        path: "/w/notes/arch",
        children: [{ kind: "file", name: "adr-007.md", path: "/w/notes/arch/adr-007.md" }],
      },
    ],
  },
  { kind: "file", name: "readme.md", path: "/w/readme.md" },
];

describe("flattenFiles", () => {
  it("최근이 앞에, 워크스페이스 트리는 깊이 우선으로 이어진다", () => {
    const out = flattenFiles([{ path: "/w/notes/todo.md", name: "todo.md" }], tree, "/w");
    expect(out.map((f) => f.path)).toEqual([
      "/w/notes/todo.md", // 최근
      "/w/notes/meeting.md", // 트리(나머지)
      "/w/notes/arch/adr-007.md",
      "/w/readme.md",
    ]);
  });

  it("rel은 루트 기준 상대 디렉터리 — 루트 밖 최근 문서는 전체 디렉터리", () => {
    const out = flattenFiles([{ path: "/other/외부.md", name: "외부.md" }], tree, "/w");
    expect(out[0].rel).toBe("/other");
    expect(out[1].rel).toBe("notes"); // meeting.md
    const rootFile = out.find((f) => f.name === "readme.md");
    expect(rootFile?.rel).toBe("");
  });

  it("cap은 최근을 보존한 채 자른다", () => {
    const many: TreeNode[] = Array.from({ length: 30 }, (_, i) => ({
      kind: "file" as const,
      name: `f${i}.md`,
      path: `/w/f${i}.md`,
    }));
    const out = flattenFiles([{ path: "/r/recent.md", name: "recent.md" }], many, "/w", 10);
    expect(out).toHaveLength(10);
    expect(out[0].path).toBe("/r/recent.md");
    expect(out[9].path).toBe("/w/f8.md");
  });
});

describe("scoreFile", () => {
  const f = { path: "/w/notes/todo.md", name: "todo.md", rel: "notes" };

  it("빈 쿼리는 통과(1), 매치 없음은 -1", () => {
    expect(scoreFile("", f)).toBe(1);
    expect(scoreFile("zzz", f)).toBe(-1);
  });

  it("이름 매치가 경로 매치보다 우선한다", () => {
    const byName = { path: "/w/a.md", name: "todo.md", rel: "" };
    const byPath = { path: "/w/b.md", name: "b.md", rel: "notes/todo" };
    expect(scoreFile("todo", byName)).toBeGreaterThan(scoreFile("todo", byPath));
  });

  it("이름 접두사 매치에 보너스", () => {
    const prefix = { path: "/w/a.md", name: "todo.md", rel: "" };
    const scattered = { path: "/w/b.md", name: "t-o-d-o.md", rel: "" };
    expect(scoreFile("todo", prefix)).toBeGreaterThan(scoreFile("todo", scattered));
  });
});

describe("subsequence", () => {
  it("연속 매치가 흩어진 매치보다 고득점", () => {
    expect(subsequence("abc", "abc")).toBeGreaterThan(subsequence("abc", "axbxc"));
  });
  it("순서가 어긋나면 탈락", () => {
    expect(subsequence("ba", "abc")).toBe(-1);
  });
});
