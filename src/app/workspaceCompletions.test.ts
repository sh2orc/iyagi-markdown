import { expect, it } from "vitest";
import type { TreeNode } from "../api";
import { buildWikiIndex, resolveWikiLink } from "../editor/wiki";
import { workspaceCompletions } from "./workspaceCompletions";

it("동명·대소문자·확장자 충돌을 구분하는 실제 위키 키를 제공한다", () => {
  const tree: TreeNode[] = [
    { kind: "file", name: "Memo.md", path: "/w/Memo.md", stem: "Memo" },
    { kind: "file", name: "memo.markdown", path: "/w/memo.markdown", stem: "memo" },
    { kind: "dir", name: "notes", path: "/w/notes", children: [
      { kind: "file", name: "memo.md", path: "/w/notes/memo.md", stem: "memo" },
      { kind: "file", name: "unique.md", path: "/w/notes/unique.md" },
    ] },
  ];
  const { docs } = workspaceCompletions(tree), index = buildWikiIndex(tree);
  expect(docs.map((doc) => doc.target)).toEqual(["/Memo.md", "/memo.markdown", "/notes/memo.md", "unique"]);
  for (const doc of docs) expect(resolveWikiLink(doc.target!, "/w/notes", index)).toBe(doc.path);
  expect(docs[0].name).toBe("Memo");
});

it("위키 구분자가 든 파일명은 일반 링크 대상으로 표시한다", () => {
  const { docs } = workspaceCompletions([{ kind: "file", name: "a#b [1].md", path: "/w/a#b [1].md" }]);
  expect(docs[0]).toEqual({ name: "a#b [1]", path: "/w/a#b [1].md", target: null });
});

it("루트 경로가 같아도 중첩 폴더 변경을 반영하고 유효한 태그만 제안한다", () => {
  const tree = (name: string): TreeNode[] => [{ kind: "dir", name: "notes", path: "/w/notes", children: [
    { kind: "dir", name, path: `/w/notes/${name}`, children: [] },
    { kind: "dir", name: "two words", path: "/w/notes/two words", children: [] },
    { kind: "dir", name: "１２３", path: "/w/notes/１２３", children: [] },
  ] }];
  expect(workspaceCompletions(tree("old")).tags).toEqual(["notes", "old"]);
  expect(workspaceCompletions(tree("new")).tags).toEqual(["new", "notes"]);
});
