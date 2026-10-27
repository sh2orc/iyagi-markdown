// 인용·서지 순수 로직 — 정의 파싱·첫 등장 순 번호·표시 문자열.
// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";

import { brokenCitations, citeDisplay, citeNumbering, citationNumberingForDocument, citationsInRange, isCiteDefLine } from "./citations";

const DOC = [
  "서론 [@kim2020]와 연구 [@lee2021, p. 12].",
  "",
  "```",
  "[@fence]: 펜스 안은 무시",
  "```",
  "",
  "[@kim2020]: Kim, S. (2020). *첫 연구*. 출판사.",
  "[@lee2021]: Lee, J. (2021). 두 번째.",
].join("\n");

describe("parseCiteDefs · citeNumbering", () => {
  it("선택 변경은 분석을 재사용하고 문서 변경은 이전 결과를 보존하며 갱신한다", () => {
    const state = EditorState.create({ doc: "[@old]\n\n[@old]: Original." });
    const original = citationNumberingForDocument(state.doc);
    const selected = state.update({ selection: { anchor: 3 } }).state;
    expect(citationNumberingForDocument(selected.doc)).toBe(original);

    const edited = selected.update({ changes: {
      from: 0, to: selected.doc.length, insert: "[@new]\n\n[@new]: Updated.",
    } }).state;
    const updated = citationNumberingForDocument(edited.doc);
    expect(updated).not.toBe(original);
    expect([...updated.defs.keys()]).toEqual(["new"]);
    expect(updated.order).toEqual(["new"]);
    expect([...original.defs.keys()]).toEqual(["old"]);
    expect(original.order).toEqual(["old"]);
    expect(citationNumberingForDocument(state.doc)).toBe(original);
  });

  it("구문상 리터럴과 메타데이터를 제외하고 원문 UTF-16 위치를 유지한다", () => {
    const text = [
      "---", "title: '[@meta]'", "[@hidden]: Meta", "---", "",
      "````markdown", "```", "[@fence]: Fake", "[@fence]", "````", "",
      "    [@indented]: Fake", "    [@code]", "",
      "`[@inline]` \\[@escaped] [label [@linked]](https://example.com) ![[@alt]](a.png)", "",
      "$[@math]$ ==[@highlight]== [[note|[@wiki] text]]", "", "<!-- [@html] -->", "",
      "본문😀 [@known,p.12] [@missing].", "", "[@known]: K.", "",
    ].join("\r\n");
    const numbering = citeNumbering(text);
    expect([...numbering.defs.keys()]).toEqual(["known"]);
    expect(numbering.order).toEqual(["known", "missing"]);
    expect(numbering.num.get("known")).toBe(1);
    expect(numbering.references.map((ref) => text.slice(ref.from, ref.to))).toEqual(["[@known,p.12]", "[@missing]"]);
    expect(numbering.references[0].suffix).toBe("p.12");
    expect(brokenCitations(text, numbering)).toEqual([{ key: "missing", pos: text.indexOf("[@missing]") }]);
    const first = numbering.references[0];
    expect(citationsInRange(numbering, first.from, first.to)).toEqual([first]);
    expect(citationsInRange(numbering, first.from + 1, first.to)).toEqual([]);
    expect(citationsInRange(numbering, first.from, first.to - 1)).toEqual([]);
  });

  it("중복 정의는 마지막 목적지만 남기고 앞 항목 내용도 보존한다", () => {
    const text = "[@a]\n\n[@a]: Old.\n[@a]: New.\n";
    const numbering = citeNumbering(text);
    expect(numbering.defs.get("a")).toEqual({ line: 4, entry: "New." });
    expect(numbering.definitions.map(({ line, entry }) => ({ line, entry }))).toEqual([
      { line: 3, entry: "Old." }, { line: 4, entry: "New." },
    ]);
  });

  it("정의 파싱(펜스 제외)·줄 번호", () => {
    const { defs } = citeNumbering(DOC);
    expect(defs.size).toBe(2);
    expect(defs.get("kim2020")?.line).toBe(7);
    expect(defs.get("kim2020")?.entry).toBe("Kim, S. (2020). *첫 연구*. 출판사.");
    expect(defs.has("fence")).toBe(false);
  });

  it("첫 등장 순 번호 — 인용 안 달린 정의는 번호 없음", () => {
    const n = citeNumbering(DOC + "\n[@unused]: 달리지 않음.");
    expect(n.order).toEqual(["kim2020", "lee2021"]); // 출현(본문 인용)만 순서에
    expect(n.num.get("kim2020")).toBe(1);
    expect(n.num.get("lee2021")).toBe(2);
    expect(n.num.has("unused")).toBe(false);
  });

  it("정의 줄 안의 [@..]는 출현으로 세지 않는다", () => {
    const n = citeNumbering("본문 [@a].\n\n[@a]: A [@b] 안쪽.\n[@b]: B.");
    expect(n.order).toEqual(["a"]);
  });
});

describe("citeDisplay · isCiteDefLine", () => {
  const n = citeNumbering(DOC);
  it("번호·접미사 표시", () => {
    expect(citeDisplay("kim2020", undefined, n)).toBe("[1]");
    expect(citeDisplay("lee2021", "p. 12", n)).toBe("[2, p. 12]");
    expect(citeDisplay("nope", undefined, n)).toBeNull();
  });
  it("정의 줄 판정", () => {
    expect(isCiteDefLine("[@a]: x")).toBe(true);
    expect(isCiteDefLine("  [@a]: x")).toBe(true);
    expect(isCiteDefLine("[@a] 본문")).toBe(false);
    expect(isCiteDefLine("```")).toBe(false);
  });
});

describe("인용 위젯 클릭 → 서지 이동(통합)", { retry: 2 }, () => {
  // jsdom은 Range.getClientRects가 없어 CM 측정 경로가 죽는다 — 스텁
  // (editor.test 486행 규약. 풀 스위트 병렬 시 언핸들 에러로 새던 원인).
  beforeAll(() => {
    const proto = Range.prototype as unknown as { getClientRects?: () => DOMRectList };
    if (!proto.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        value: () => [{ top: 0, bottom: 12, left: 0, right: 40, width: 40, height: 12 }],
      });
    }
  });
  it("클릭하면 정의 줄로 커서가 옮겨진다", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { createDocState } = await import("./cm");
    const view = new EditorView({ state: createDocState(DOC, "read"), parent: document.body });
    await new Promise((r) => setTimeout(r, 120));
    const cite = document.querySelector(".md-cite-link");
    expect(cite).not.toBeNull();
    cite!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    // kim2020 정의는 DOC의 7번 줄.
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(7);
    view.destroy();
  });
  it("코드·링크·서지 항목에는 인용 위젯이나 끊긴 인용 표시를 붙이지 않는다", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { createDocState } = await import("./cm");
    const text = "`[@ghost]` [label [@a]](https://example.com)\n\n본문 [@a].\n\n[@a]: A. [@entry]\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: createDocState(text, "read"), parent });
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(parent.querySelectorAll(".md-cite-link")).toHaveLength(1);
      expect(parent.querySelectorAll(".md-cite-broken")).toHaveLength(0);
      expect(parent.querySelectorAll(".md-cite-def")).toHaveLength(1);
    } finally { view.destroy(); parent.remove(); }
  });
  it("**[@a]**글자 처럼 마커가 짝이 안 되는 강조도 위젯이 삼켜 굵게 낸다", async () => {
    const { EditorView } = await import("@codemirror/view");
    const { createDocState } = await import("./cm");
    const text = "**[@a]**와 일반 [@a] *[@a]*끝.\n\n[@a]: A.\n";
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ state: createDocState(text, "read"), parent });
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const cites = parent.querySelectorAll(".md-cite");
      expect(cites).toHaveLength(3);
      expect(cites[0]!.classList.contains("md-cite-strong")).toBe(true);
      expect(cites[1]!.classList.contains("md-cite-strong")).toBe(false);
      expect(cites[2]!.classList.contains("md-cite-em")).toBe(true);
      // 마커(**·*)가 리터럴 텍스트로 새어 나오지 않는다.
      expect(parent.textContent).not.toContain("**");
      expect(parent.textContent).not.toContain("*");
    } finally { view.destroy(); parent.remove(); }
  });
});

describe("brokenCitations (검수 허브 카드)", () => {
  it("정의 없는 키 사용처만 — 위치는 문서 오프셋", () => {
    const doc = "서론 [@a]과 [@b, p. 3].\n\n[@a]: A. 저자.";
    const broken = brokenCitations(doc);
    expect(broken).toEqual([{ key: "b", pos: doc.indexOf("[@b") }]);
  });

  it("펜스 내부·정의 줄은 끊긴 것으로 안 친다", () => {
    const doc = ["앞 [@ok]", "", "```", "[@ghost] 와 [@fenced]", "```", "", "[@ok]: O."].join("\n");
    expect(brokenCitations(doc)).toEqual([]);
  });

  it("모두 정의되었으면 빈 배열", () => {
    expect(brokenCitations(DOC)).toEqual([]);
  });
});
