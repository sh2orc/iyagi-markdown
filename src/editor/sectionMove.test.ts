// 섹션 이동 계산 — 범위·무효 이동·삭제 보정의 순수 단위 테스트.

import { describe, expect, it } from "vitest";

import { moveSection, sectionMoveChanges, sectionRange } from "./sectionMove";
import { collectHeadings, type Heading } from "../links";
import { EditorState } from "@codemirror/state";

const H = (level: number, text: string, pos: number): Heading => ({
  level,
  text,
  slug: text,
  pos,
});

// 문서: "# A … # B … ## B1 … # C" — 줄 단위 대략 위치.
const DOC = "# A\n내용A\n\n# B\n내용B\n\n## B1\n내용B1\n\n# C\n내용C\n";
const POS = (needle: string): number => DOC.indexOf(needle);
const HS: Heading[] = [
  H(1, "A", POS("# A")),
  H(1, "B", POS("# B")),
  H(2, "B1", POS("## B1")),
  H(1, "C", POS("# C")),
];

describe("sectionRange", () => {
  it("다음 동급/상위 제목 전까지", () => {
    expect(sectionRange(HS, 0, DOC.length)).toEqual({ from: POS("# A"), to: POS("# B") });
    expect(sectionRange(HS, 1, DOC.length)).toEqual({ from: POS("# B"), to: POS("# C") }); // 하위 B1 포함
    expect(sectionRange(HS, 3, DOC.length)).toEqual({ from: POS("# C"), to: DOC.length });
  });
});

describe("moveSection", () => {
  it("앞으로 이동 — 삽입 위치 그대로", () => {
    const m = moveSection(HS, 1, 0, DOC.length); // B 섹션를 A 앞으로
    expect(m).toEqual({
      from: POS("# B"),
      to: POS("# C"),
      insertAt: POS("# A"),
      cursor: POS("# A"),
    });
  });

  it("뒤로 이동 — 삭제 길이만큼 삽입 위치 보정", () => {
    const m = moveSection(HS, 0, 3, DOC.length); // A 섹션를 C 앞으로
    const aLen = POS("# B") - POS("# A");
    expect(m?.insertAt).toBe(POS("# C") - aLen);
  });

  it("자기 내부·같은 항목은 무효(null)", () => {
    expect(moveSection(HS, 1, 1, DOC.length)).toBeNull();
    expect(moveSection(HS, 1, 2, DOC.length)).toBeNull(); // B 섹션 안의 B1 앞
  });
});

describe("sectionMoveChanges", () => {
  const apply = (doc: string, from: number, to: number) => {
    const result = sectionMoveChanges(collectHeadings(doc), from, to, doc)!;
    const state = EditorState.create({ doc }).update({ changes: result.changes, selection: { anchor: result.cursor } }).state;
    return { text: state.doc.toString(), cursor: state.selection.main.head };
  };
  it("많은 빈 줄과 Markdown 줄바꿈 공백을 잘라내지 않고 이동한다", () => {
    const a = "# A\nfirst  \n\n\n\n", b = "# B\nsecond\n\n", c = "# C\nthird  \n";
    const result = apply(a + b + c, 0, 2);
    expect(result.text).toBe(b + a + c);
    expect(result.cursor).toBe(b.length);
  });
  it("개행 없는 마지막 섹션도 제목 경계를 유지한다", () => {
    const result = apply("# A\n\nbody\n\n# Last\nend  ", 1, 0);
    expect(result.text).toBe("# Last\nend  \n\n# A\n\nbody\n\n");
    expect(result.cursor).toBe(0);
  });
  it("컨테이너 제목을 섹션 경계나 이동 대상으로 삼지 않는다", () => {
    const doc = "# A\n\n> # quoted\n\n# B\n\nbody\n";
    const headings = collectHeadings(doc);
    expect(sectionRange(headings, 0, doc.length)).toEqual({ from: 0, to: doc.indexOf("# B") });
    expect(sectionMoveChanges(headings, 1, 2, doc)).toBeNull();
    expect(sectionMoveChanges(headings, 2, 1, doc)).toBeNull();
    expect(apply(doc, 2, 0).text).toContain("# A\n\n> # quoted\n\n");
  });
  it("인접한 다음 제목 앞에 이미 있는 섹션은 바꾸지 않는다", () => {
    const doc = "# A\n\nbody\n\n# B\n";
    expect(sectionMoveChanges(collectHeadings(doc), 0, 1, doc)).toBeNull();
  });
});
