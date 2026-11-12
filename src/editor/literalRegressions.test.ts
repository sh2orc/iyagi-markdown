// 2026-11 2차 감사 회귀 — 코드 안 글자를 문법으로 오인하던 변환들과 링크 재조준.
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { createDocState } from "./cm";
import { copyFormat, pasteFormat, resetPainted } from "./formatPainter";
import { stripFrontMatter } from "./frontmatter";
import { countHeadingLinks, headingAtCursor, retargetHeadingLinks } from "./headingRename";
import { inRanges, literalRanges } from "./literalRanges";
import { extendedCursors } from "./multiCursor";
import { extractTags } from "./tags";
import { looksLikeTsv } from "./tsvTable";
import { buildWikiIndex, inlineEmbeds, resolveWikiLink, wikiLinksToMarkdown } from "./wiki";

describe("literalRanges", () => {
  it("펜스는 같은 문자·길이로만 닫히고 인라인 코드도 잡는다", () => {
    const text = "a `x` b\n~~~\n```\n#in\n~~~\nafter ``c`d`` e\n";
    const ranges = literalRanges(text);
    const inside = (needle: string) => inRanges(ranges, text.indexOf(needle));
    expect(inside("x`")).toBe(true);
    expect(inside("#in")).toBe(true);
    expect(inside("after")).toBe(false);
    expect(inside("c`d")).toBe(true);
    expect(inside(" e")).toBe(false);
  });

  it("닫히지 않은 펜스는 문서 끝까지", () => {
    const text = "x\n```\ncode [[a]]\n";
    expect(inRanges(literalRanges(text), text.indexOf("[["))).toBe(true);
  });
});

describe("내보내기 위키 변환은 코드를 건드리지 않는다", () => {
  it("bash `[[ -f x ]]`와 인라인 코드의 [[a]]는 그대로, 본문 링크만 변환", () => {
    const source = "```bash\nif [[ -f x ]]; then echo; fi\n```\n\ninline `[[a]]` and [[b]]\n";
    const out = wikiLinksToMarkdown(source, () => null, "/docs");
    expect(out).toContain("if [[ -f x ]]; then");
    expect(out).toContain("`[[a]]`");
    expect(out).toContain("[b](b.md)");
  });

  it("코드 펜스 안의 ![[n]]은 임베드하지 않고, CRLF 프런트매터는 떼어 낸다", async () => {
    const read = async () => "---\r\ntitle: x\r\n---\r\nBODY";
    const out = await inlineEmbeds("```\n![[n]]\n```\n\n![[n]]\n", () => "/n.md", read);
    expect(out).toBe("```\n![[n]]\n```\n\nBODY\n");
  });
});

describe("위키링크 해석", () => {
  it("자모 분해형(NFD) 파일명을 조합형(NFC) 입력으로 찾는다", () => {
    const name = "한글노트".normalize("NFD");
    const index = buildWikiIndex([{ kind: "file", name: `${name}.md`, path: `/w/${name}.md` } as never]);
    expect(resolveWikiLink("한글노트", "/w", index)).toBe(`/w/${name}.md`);
  });
});

describe("태그·TSV·프런트매터", () => {
  it("~~~ 안의 ``` 한 줄이 펜스 안팎을 뒤집지 않는다", () => {
    const tags = extractTags("# 제목 #tag1\n~~~\n```\n#notag\n~~~\n#real `#code` #a/b\n").map((t) => t.tag);
    expect(tags).toEqual(["a/b", "real", "tag1"]);
  });

  it("탭으로 들여쓴 코드는 표가 아니다", () => {
    expect(looksLikeTsv("\tif (x) {\n\t\treturn 1;\n\t}")).toBe(false);
    expect(looksLikeTsv("a\tb\n1\t2")).toBe(true);
  });

  it("닫는 --- 뒤 공백이 있어도 편집기와 같은 범위를 뗀다", () => {
    expect(stripFrontMatter("---\ntitle: x\n--- \nbody\n")).toBe("body\n");
  });
});

describe("제목 이름 바꾸기", () => {
  it("중복 제목은 실제 앵커로 구분한다 — 다른 제목의 링크를 가로채지 않는다", () => {
    const text = "# Shared\n\n# Renamed\n\n[[#shared]] [[#Shared]] [[#shared-1]]\n";
    const out = retargetHeadingLinks(text, "doc", "Shared", "Renamed", { old: "shared-1", next: "renamed" });
    expect(out).toBe("# Shared\n\n# Renamed\n\n[[#shared]] [[#Shared]] [[#Renamed]]\n");
  });

  it("목차가 만드는 마크다운 앵커 링크와 느슨한 위키 표기를 함께 갱신한다", () => {
    const text = "- [Old Title](#old-title)\n[[Doc#old title]] [[sub/doc#Old Title|a|b]] [x](doc.md#old-title) [y](other.md#old-title)\n`[[doc#Old Title]]`\n";
    expect(retargetHeadingLinks(text, "doc", "Old Title", "New")).toBe(
      "- [Old Title](#new)\n[[Doc#New]] [[sub/doc#New|a|b]] [x](doc.md#new) [y](other.md#old-title)\n`[[doc#Old Title]]`\n",
    );
    expect(countHeadingLinks(text, "doc", "Old Title")).toBe(4);
  });

  it("새 제목의 문법 글자는 슬러그로 쓴다", () => {
    expect(retargetHeadingLinks("[[doc#Old]]", "doc", "Old", "A|B ]] x")).toBe("[[doc#ab-x]]");
  });

  it("코드 펜스 안의 # 줄은 제목이 아니고, 닫는 #은 제목 글자가 아니다", () => {
    const fenced = "```\n# not heading\n```\n";
    expect(headingAtCursor(EditorState.create({ doc: fenced, selection: { anchor: 6 } }))).toBeNull();
    const closed = headingAtCursor(EditorState.create({ doc: "## Title ##\n", selection: { anchor: 4 } }));
    expect(closed?.title).toBe("Title");
  });
});

describe("커서·서식", () => {
  it("아래 줄 커서 추가가 이모지 한가운데에 서지 않는다", () => {
    const state = EditorState.create({
      doc: "abc\na😀c", selection: EditorSelection.cursor(2),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    const heads = extendedCursors(state, false)!.ranges.map((r) => r.head);
    for (const head of heads) {
      const code = state.doc.sliceString(head, head + 1).charCodeAt(0);
      expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
    }
  });

  it("서식 복사는 코드를 가장 안쪽에 둔다", () => {
    resetPainted();
    const view = new EditorView({ state: createDocState("**`code`** plain", "edit"), parent: document.body });
    view.dispatch({ selection: { anchor: 5 } });
    expect(copyFormat(view)).toBe(true);
    view.dispatch({ selection: { anchor: 11, head: 16 } });
    expect(pasteFormat(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("**`code`** **`plain`**");
    view.destroy();
    resetPainted();
  });
});
