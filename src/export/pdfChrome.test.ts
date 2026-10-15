// PDF 페이지 장식(머리글·바닥글) — 컬럼마다 absolute 요소를 심는 스크립트
// 조각이 올바른 조합으로 나오는지(순수 함수 — 렌더 불필요).

import { describe, expect, it } from "vitest";

import { pdfPageChrome } from "./html";

describe("pdfPageChrome", () => {
  it("번호+머리글: 둘 다의 요소와 제목 리터럴이 스크립트에 있다", () => {
    const c = pdfPageChrome(true, "3분기 보고서");
    expect(c.css).toContain(".pdf-pagenum");
    expect(c.body).toContain('class="pdf-pagenum"');
    expect(c.body).toContain('class="pdf-head"');
    expect(c.script).toContain("pdf-pagenum-data");
    expect(c.script).toContain("pdf-head-data");
    expect(c.script).toContain('"3분기 보고서"');
    expect(c.script).toContain("borderBottom");
  });

  it("번호만: 머리글 요소·제목이 없다", () => {
    const c = pdfPageChrome(true, null);
    expect(c.script).toContain("pdf-pagenum-data");
    expect(c.script).not.toContain("pdf-head-data");
    expect(c.body).not.toContain("pdf-head");
  });

  it("바닥글 텍스트: 리터럴이 스크립트에 있고 쪽번호와 결합한다", () => {
    const c = pdfPageChrome(true, null, "기밀 문서");
    expect(c.script).toContain('"기밀 문서"');
    expect(c.script).toContain("FOOTER + ' · ' + core");
  });

  it("바닥글만(번호 없음): 번호 스캔이 비활성화된다", () => {
    const c = pdfPageChrome(false, null, "초안");
    expect(c.body).toContain('class="pdf-pagenum"');
    expect(c.script).toContain("var core = false");
  });

  it("머리글만: 번호 요소가 없다", () => {
    const c = pdfPageChrome(false, "제목");
    expect(c.script).not.toContain("pdf-pagenum-data");
    expect(c.script).toContain("pdf-head-data");
  });

  it("둘 다 없으면 완전히 비어 있다", () => {
    expect(pdfPageChrome(false, null)).toEqual({ css: "", body: "", script: "" });
    expect(pdfPageChrome(false, "")).toEqual({ css: "", body: "", script: "" });
  });

  it("머리글은 표지(1쪽)에 심지 않는다", () => {
    const c = pdfPageChrome(true, "제목");
    expect(c.script).toContain("headHost && i > 1");
  });

  it("제목의 </script>는 태그 탈출이 막힌다", () => {
    const c = pdfPageChrome(true, "a</script>b");
    expect(c.script).not.toContain("a</script>b");
    expect(c.script).toContain("<\\/");
  });
});
