// 제목 이름 바꾸기 — 커서 제목 인식, 링크 재조준, 개수.
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { countHeadingLinks, headingAtCursor, retargetHeadingLinks, rewrittenHeadingLine } from "./headingRename";

describe("headingAtCursor", () => {
  const state = (doc: string, pos: number) => EditorState.create({ doc, selection: { anchor: pos } });
  it("커서가 제목 줄에 있으면 텍스트, 아니면 null", () => {
    expect(headingAtCursor(state("# 제목\n본문\n", 4))?.title).toBe("제목");
    expect(headingAtCursor(state("본문\n## 부제\n", 2))).toBeNull();
    expect(headingAtCursor(state("#\n", 1))).toBeNull(); // 빈 제목 아님
  });
});

describe("retargetHeadingLinks", () => {
  it("이 문서를 가리키는 앵커만 — 제목·슬러그 두 표기 모두", () => {
    const text = "[[note#부제|보기]] [[note#부제]] [[#부제]] [[other#부제]] [[note]] [[note#다른것]]";
    const out = retargetHeadingLinks(text, "note", "부제", "새 제목")!;
    expect(out).toContain("[[note#새 제목|보기]]");
    expect(out).toContain("[[note#새 제목]]");
    expect(out).toContain("[[#새 제목]]");
    expect(out).toContain("[[other#부제]]"); // 다른 문서는 그대로
    expect(out).toContain("[[note]]"); // 앵커 없는 링크 그대로
    expect(out).toContain("[[note#다른것]]"); // 다른 앵커 그대로
  });
  it("슬러그 기준 링크도 새 제목 표기로(slugify는 한글 보존 — 공백만 -)", () => {
    // 제목 "새 섹션"의 슬러그는 "새-섹션" — 슬러그로 쓴 링크도 갱신.
    expect(retargetHeadingLinks("[[note#새-섹션]]", "note", "새 섹션", "바뀜")).toBe("[[note#바뀜]]");
  });
  it("변경이 없으면 null — 같은 슬러그·대상 없음", () => {
    expect(retargetHeadingLinks("[[note#부제]]", "note", "부제", "부제")).toBeNull();
    expect(retargetHeadingLinks("[[a#다른]]", "note", "부제", "새로")).toBeNull();
  });
});

describe("count/rewritten", () => {
  it("링크 수 — 같은 문서·이 문서 대상만", () => {
    expect(countHeadingLinks("[[n#a]] [[#a]] [[x#a]] [[n#a]]", "n", "a")).toBe(3);
    expect(countHeadingLinks("[[n#b]]", "n", "a")).toBe(0);
  });
  it("제목 줄 재작성 — 수준 유지", () => {
    expect(rewrittenHeadingLine("### 옛 제목", "새")).toBe("### 새");
  });
});
