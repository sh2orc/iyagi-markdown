// 전체 검색 결과 하이라이트 조각화 테스트 — 대소문자무시 부분문자열이
// Rust search_tree와 같은 규칙인지(하이라이트가 매치와 어긋나면 거짓 안내).

import { describe, expect, it } from "vitest";

import { splitHighlights } from "./searchCm";

describe("splitHighlights", () => {
  it("대소문자무시로 매치를 감싼다", () => {
    expect(splitHighlights("World MARKER here", "marker")).toEqual([
      { text: "World ", hit: false },
      { text: "MARKER", hit: true },
      { text: " here", hit: false },
    ]);
  });

  it("여러 매치를 모두 감싼다", () => {
    expect(splitHighlights("a needle b needle", "needle").filter((p) => p.hit)).toEqual([
      { text: "needle", hit: true },
      { text: "needle", hit: true },
    ]);
  });

  it("매치 없음·빈 검색어는 한 조각", () => {
    expect(splitHighlights("그냥 줄", "zzz")).toEqual([{ text: "그냥 줄", hit: false }]);
    expect(splitHighlights("그냥 줄", "  ")).toEqual([{ text: "그냥 줄", hit: false }]);
  });

  it("말줄임표(…)가 낀 클립 줄도 정확히", () => {
    const parts = splitHighlights("…앞부분 needle 뒷…", "needle");
    expect(parts[1]).toEqual({ text: "needle", hit: true });
  });
});
