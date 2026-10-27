// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { asyncEditPlugin } from "./asyncEdit";
import { captureInlineLinkEdit } from "./inlineLinkEdit";
import { documentImages } from "./documentImages";

describe("document image gallery", () => {
  it("문서 순서와 원문 범위를 보존하며 코드·메타데이터·수식의 예시를 제외한다", () => {
    const source = [
      "---", "example: '![metadata](meta.png)'", "---", "",
      "`![inline](code.png)`", "", "```md", "![fenced](code.png)", "```", "",
      "    ![indented](code.png)", "", "$![math](math.png)$", "",
      "$$", "![block math](math.png)", "$$", "",
      "> ![first](assets/shared.png)", "",
      "- ![second](assets/shared.png)", "",
      '[![linked](<assets/image (1).png> "title")](page.md)', "",
      "\\![escaped](ignored.png)", "",
      "![reference][ref]", "", "[ref]: ignored.png",
    ].join("\n");
    const images = documentImages(source, "/notes");
    expect(images.map(({ src, alt }) => ({ src, alt }))).toEqual([
      { src: "/notes/assets/shared.png", alt: "first" },
      { src: "/notes/assets/shared.png", alt: "second" },
      { src: "/notes/assets/image (1).png", alt: "linked" },
    ]);
    expect(images.map(({ from, to }) => source.slice(from, to))).toEqual([
      "![first](assets/shared.png)", "![second](assets/shared.png)",
      '![linked](<assets/image (1).png> "title")',
    ]);
  });

  it("URL 괄호·엔티티·이스케이프 설명과 상대 경로를 같은 규칙으로 읽는다", () => {
    const source = '![\\[설명\\] &amp;](../img/a%20b.png) ![remote](https://example.com/a(b).png?x=1&amp;y=2)';
    expect(documentImages(source, "/notes/sub").map(({ src, alt }) => ({ src, alt }))).toEqual([
      { src: "/notes/img/a b.png", alt: "[설명] &" },
      { src: "https://example.com/a(b).png?x=1&y=2", alt: "remote" },
    ]);
  });

  it("같은 주소의 두 번째 이미지만 편집하며 기존 제목을 유지한다", () => {
    const source = '![first](shared.png "one")\n\n![second](shared.png "two")';
    const host = document.createElement("div"); document.body.append(host);
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: source, extensions: [asyncEditPlugin] }) });
    try {
      const second = documentImages(source, "/notes")[1];
      const edit = captureInlineLinkEdit(view, second.from, second.to)!;
      expect(edit.apply({ text: "changed", url: "shared.png" })).toBe(true);
      expect(view.state.doc.toString()).toBe('![first](shared.png "one")\n\n![changed](shared.png "two")');
    } finally { view.destroy(); host.remove(); }
  });
});
