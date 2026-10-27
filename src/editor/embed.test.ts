// 노트 임베드 ![[이름]] — 구문 확장·인라인 재귀·순환/깊이 방어.
// @vitest-environment jsdom
import { beforeAll, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";

import { createDocState } from "./cm";
import { __testing, setPreviewConfig } from "./livePreview";
import { inlineEmbeds } from "./wiki";

const PREVIEW = setPreviewConfig.of({
  baseDir: "/w",
  remoteImages: true,
  showImages: true,
  theme: "light",
  imageWidths: {},
  bookmarks: [],
  tableWidths: {},
  wikiIndex: new Map([["메모", ["/w/메모.md"]], ["빈문서", ["/w/빈문서.md"]]]),
});

beforeAll(() => {
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
  }
});

it("![[이름]]이 Embed 노드로 파싱되고 [[..]]·이미지와 갈라진다", async () => {
  const view = new EditorView({
    state: createDocState("before ![[메모]] after\n\n[[메모]]\n\n![alt](a.png)\n", "edit"),
    parent: document.body,
  });
  view.dispatch({ effects: PREVIEW });
  await new Promise((r) => setTimeout(r, 140));
  const embed = document.querySelector(".md-embed");
  expect(embed).not.toBeNull();
  expect(embed?.getAttribute("data-wiki-path")).toBe("/w/메모.md");
  expect(embed?.className).not.toContain("is-missing");
  // 일반 위키링크는 여전히 링크 위젯 — 임베드가 아니다.
  expect(document.querySelector(".md-wikilink")).not.toBeNull();
  // 이미지도 임베드가 아니다.
  expect(document.querySelectorAll(".md-embed")).toHaveLength(1);
  view.destroy();
  document.body.innerHTML = "";
});

it("정의 없는 임베드는 끊김 표시", async () => {
  const view = new EditorView({
    state: createDocState("![[없는문서]]\n", "edit"),
    parent: document.body,
  });
  view.dispatch({ effects: PREVIEW });
  await new Promise((r) => setTimeout(r, 140));
  const embed = document.querySelector(".md-embed");
  expect(embed?.className).toContain("is-missing");
  view.destroy();
  document.body.innerHTML = "";
});

it("inlineEmbeds — 대상 원문 삽입·재귀·순환·깊이·실패 보존", async () => {
  const files: Record<string, string> = {
    "/w/a.md": "# A\n\n![[b]] 내용",
    "/w/b.md": "B 본문\n\n![[a]]", // 순환
    "/w/c.md": "![[d]]",
    "/w/d.md": "깊은 곳",
    "/w/메모.md": "---\ntitle: 메모\n---\n메모 본문",
  };
  const resolve = (name: string) =>
    ({ a: "/w/a.md", b: "/w/b.md", c: "/w/c.md", d: "/w/d.md", 메모: "/w/메모.md", 없음: null })[name] ?? null;
  const read = (path: string) => Promise.resolve(files[path] ?? null);
  // 프론트매터 제거 후 삽입
  expect(await inlineEmbeds("![[메모]]", resolve, read)).toBe("메모 본문");
  // 재귀 + 순환 방어(a→b→a에서 두 번째 a는 원문 보존)
  const out = await inlineEmbeds("![[a]]", resolve, read);
  expect(out).toContain("# A");
  expect(out).toContain("B 본문");
  expect(out).toContain("![[a]]"); // 순환 지점은 원문
  // 읽기 실패·해석 실패는 원문 보존
  expect(await inlineEmbeds("![[없음]]", resolve, read)).toBe("![[없음]]");
  expect(await inlineEmbeds("![[a]]", resolve, () => Promise.resolve(null))).toBe("![[a]]");
  // 깊이 상한 — a→b→(a 순환) 경로 외에 c→d 정상
  expect(await inlineEmbeds("![[c]]", resolve, read)).toContain("깊은 곳");
});

it("applyEmbeds — 문서 메모가 있으면 줄 보호를 위해 건너뛴다", async () => {
  const { applyEmbeds, captureExportSnapshot } = await import("../export/snapshot");
  const { EditorState } = await import("@codemirror/state");
  const snap = captureExportSnapshot({
    state: EditorState.create({ doc: "![[메모]]\n" }),
    path: "/w/index.md", title: "index.md", docStyle: null, comments: [], savedText: "",
  }, { workspace: "/w", theme: "light", pageNumbers: false, header: false,
       wikiIndex: new Map([["메모", ["/w/메모.md"]]]) });
  const read = () => Promise.resolve("메모 본문");
  const withEmbeds = await applyEmbeds(snap, read);
  expect(withEmbeds.markdown).toContain("메모 본문");
  expect(withEmbeds.markdown).not.toContain("![[메모]]");
  // 메모가 있으면 불변
  const withComments = { ...snap, comments: [[1, "메모"]] as [number, string][] } as typeof snap;
  expect(await applyEmbeds(withComments, read)).toBe(withComments);
});
