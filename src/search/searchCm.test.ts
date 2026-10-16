// 전체 검색 결과 하이라이트 조각화 테스트 — 대소문자무시 부분문자열이
// Rust search_tree와 같은 규칙인지(하이라이트가 매치와 어긋나면 거짓 안내).

import { describe, expect, it } from "vitest";

import { computeMatches, splitHighlights, wholeWordRegexSource } from "./searchCm";

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

describe("wholeWord 단어 단위 찾기", () => {
  const doc = "cat catalog cat. concat CAT";

  it("단어 단위 — 부분 문자열(cat in catalog)은 제외", () => {
    const m = computeMatches(doc, { text: "cat", caseSensitive: false, regexp: false, wholeWord: true });
    expect(m.length).toBe(3); // cat, cat., CAT
  });

  it("단어 단위 없음 — 모든 부분 일치", () => {
    const m = computeMatches(doc, { text: "cat", caseSensitive: false, regexp: false });
    expect(m.length).toBe(5); // cat, cat(alog), cat., con(cat), CAT
  });

  it("대소문자 구분 결합", () => {
    const m = computeMatches(doc, { text: "cat", caseSensitive: true, regexp: false, wholeWord: true });
    expect(m.length).toBe(2); // cat, cat. (CAT 제외)
  });

  it("정규식과 결합 — 그룹으로 감싸 경계 적용", () => {
    const m = computeMatches("abc abcde", { text: "abc", caseSensitive: true, regexp: false, wholeWord: true });
    expect(m.length).toBe(1);
  });

  it("한글 검색어는 단어 경계 미적용(\b가 죽는 문제 회피)", () => {
    expect(wholeWordRegexSource("문서", false)).toBeNull();
    const m = computeMatches("문서 문서고", { text: "문서", caseSensitive: false, regexp: false, wholeWord: true });
    expect(m.length).toBe(2); // 일반 검색과 동일
  });

  it("경계는 단어 문자 가장자리에만", () => {
    expect(wholeWordRegexSource("word", false)).toBe("\\b(?:word)\\b");
    expect(wholeWordRegexSource("100", false)).toBe("\\b(?:100)\\b");
    // 앞만 라틴 — 앞에만 경계.
    expect(wholeWordRegexSource("id:", false)).toBe("\\b(?:id:)");
  });
});

// findNext — 42차 메뉴 케이스가 의존하는 이동 명령의 직접 검증(키·메뉴
// 경로와 같은 함수 — 15차 '실제 경로 검증'의 순수 버전).
// @vitest-environment jsdom
describe("findNext (이동 명령)", () => {
  it("쿼리 있으면 커서 기준 다음/이전 매치로 순환", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { EditorState } = await import("@codemirror/state");
    const { searchField, findNext, setSearchState, searchStateOf } = await import("./searchCm");
    // jsdom 스크롤 측정 스텁(editor.test 규약)
    const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList };
    if (!proto.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        value: () => [{ top: 0, bottom: 12, left: 0, right: 40, width: 40, height: 12 }],
      });
    }
    const state = EditorState.create({
      doc: "alpha beta gamma beta\n",
      extensions: [searchField],
    });
    const view = new EditorView({ state, parent: document.body });
    view.dispatch({ effects: setSearchState.of({ query: { text: "beta", caseSensitive: false, regexp: false } }) });
    expect(searchStateOf(view.state).matches.length).toBe(2);
    findNext(view, true); // 커서 0 → 첫 매치
    expect(view.state.selection.main.from).toBe(6);
    findNext(view, true); // → 둘째 매치
    expect(view.state.selection.main.from).toBe(17);
    findNext(view, true); // 끝 → 처음으로 순환
    expect(view.state.selection.main.from).toBe(6);
    findNext(view, false); // 역방향
    expect(view.state.selection.main.from).toBe(17);
    view.destroy();
  });
});
