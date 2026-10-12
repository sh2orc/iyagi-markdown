// 끊긴 위키링크 검사 테스트 — 해석되는 것은 안 걸리고, 펜스 안은 무시.

import { describe, expect, it } from "vitest";

import { brokenWikiLinks } from "./brokenLinks";

const IDX = new Map<string, string[]>([["존재".toLowerCase(), ["/w/존재.md"]]]);
const resolve = (name: string) => (IDX.has(name.toLowerCase()) ? "/w/존재.md" : null);

describe("brokenWikiLinks", () => {
  it("끊긴 것만, 줄 번호·위치와 함께", () => {
    const text = "여기 [[존재]] 참조.\n그리고 [[없는문서]] 도.\n";
    const broken = brokenWikiLinks(text, resolve);
    expect(broken).toEqual([{ line: 2, name: "없는문서", from: text.indexOf("[[없는문서]") }]);
  });

  it("같은 줄 여러 개, 표시·앵커 붙은 것, 빈 이름 제외", () => {
    const text = "[[a|표시]] 와 [[b#앵커]]와 [[]]\n";
    const broken = brokenWikiLinks(text, resolve);
    expect(broken.map((b) => b.name)).toEqual(["a", "b"]);
  });

  it("코드 펜스 안은 무시", () => {
    const text = "```md\n[[펜스안]]\n```\n[[밖]]\n";
    const broken = brokenWikiLinks(text, resolve);
    expect(broken.map((b) => b.name)).toEqual(["밖"]);
  });
});
