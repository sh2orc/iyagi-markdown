// 호버 미리보기 텍스트 준비 테스트 — 제목 추출·마커 정리·길이 제한의 정확성.

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  cachedLinkPreview,
  footnoteDefinition,
  previewRenderInput,
  ttsTextOf,
  cleanMarkers,
  invalidateLinkPreviews,
  previewTextOf,
  rememberLinkPreview,
} from "./linkPreview";

const DOC = `---
title: 메타
---

# 노트 제목

첫 문단입니다. **강조**와 \`code\`가 섞여 있다.

둘째 문단(미리보기에 안 나온다).

## 다음 절

내용.
`;

describe("previewTextOf", () => {
  it("프론트매터 제외, 첫 # 제목 + 첫 문단(마커 정리)", () => {
    const p = previewTextOf(DOC);
    expect(p.title).toBe("노트 제목");
    expect(p.body).toBe("첫 문단입니다. 강조와 code가 섞여 있다.");
  });

  it("제목 없으면 첫 줄, 문단 비면 빈 body", () => {
    expect(previewTextOf("그냥 첫 줄입니다.\n").title).toBe("그냥 첫 줄입니다.");
    expect(previewTextOf("# 제목뿐\n").body).toBe("");
    expect(previewTextOf("").title).toBe("");
  });

  it("길이 제한 — maxChars 넘으면 말줄임", () => {
    const long = "가".repeat(1000);
    const p = previewTextOf(`# T\n\n${long}\n`, 50);
    expect(p.body.length).toBe(50);
    expect(p.body.endsWith("…")).toBe(true);
  });
});

describe("cleanMarkers", () => {
  it("이미지·링크·위키·강조·취소 정리", () => {
    expect(cleanMarkers("![대체](x.png)")).toBe("대체");
    expect(cleanMarkers("[텍스트](https://a.b)")).toBe("텍스트");
    expect(cleanMarkers("[[노트|보여주기]]와 [[다른 노트]]")).toBe("보여주기와 다른 노트");
    expect(cleanMarkers("**굵게** *기울임* ~~취소~~ `code` ==형광==")).toBe(
      "굵게 기울임 취소 code 형광",
    );
    expect(cleanMarkers("> 인용 줄")).toBe("인용 줄");
    expect(cleanMarkers("- 항목")).toBe("• 항목");
  });
});

describe("미리보기 캐시", () => {
  it("LRU — 재조회로 갱신, 최대 30에서 가장 오래된 것 제거, 무효화", () => {
    rememberLinkPreview("/a", { title: "A", body: "a", html: null });
    rememberLinkPreview("/b", { title: "B", body: "b", html: null });
    expect(cachedLinkPreview("/a")?.title).toBe("A"); // LRU 순서 갱신
    for (let i = 0; i < 29; i++) rememberLinkPreview(`/x${i}`, { title: `X${i}`, body: "", html: null });
    expect(cachedLinkPreview("/b")).toBeNull(); // 갱신 안 한 b가 밀려남
    expect(cachedLinkPreview("/a")?.title).toBe("A"); // a는 살아남
    invalidateLinkPreviews("/a");
    expect(cachedLinkPreview("/a")).toBeNull();
    rememberLinkPreview("/z", { title: "Z", body: "", html: null });
    invalidateLinkPreviews();
    expect(cachedLinkPreview("/z")).toBeNull();
  });
});

describe("previewRenderInput(v2 렌더 입력)", () => {
  it("문단 경계에서 자르고 말줄임 표시", () => {
    const paras = Array.from({ length: 200 }, (_, i) => `문단${i} ${"가".repeat(30)}`).join("\n\n");
    const out = previewRenderInput(paras, 400);
    expect(out.length).toBeLessThanOrEqual(402);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("문단199");
  });

  it("짧으면 그대로, 프론트매터 제외", () => {
    expect(previewRenderInput("# T\n\n본문\n")).toBe("# T\n\n본문");
    expect(previewRenderInput("---\nx: 1\n---\n\n본문\n")).toBe("본문");
  });
});

describe("footnoteDefinition", () => {
  const doc = "본문[^1] 과 각주.\n\n[^1]: 첫 **각주** 내용 — `코드` 포함.\n    이어지는 줄.\n\n[^2]: 둘째.\n";

  it("라벨 정의를 찾아 마커 정리·연속 줄 결합", () => {
    expect(footnoteDefinition(doc, "1")).toBe("첫 각주 내용 — 코드 포함. 이어지는 줄.");
  });

  it("없는 라벨·빈 라벨은 빈 문자열", () => {
    expect(footnoteDefinition(doc, "9")).toBe("");
    expect(footnoteDefinition(doc, "")).toBe("");
  });

  it("정규식 특수문자 라벨도 안전", () => {
    const d = "본문[^a.b*c].\n\n[^a.b*c]: 특수 라벨 각주.\n";
    expect(footnoteDefinition(d, "a.b*c")).toBe("특수 라벨 각주.");
  });

  it("긴 정의는 maxChars에서 자른다", () => {
    const long = "설명 ".repeat(200).trim();
    const d = `본문[^x].\n\n[^x]: ${long}\n`;
    const out = footnoteDefinition(d, "x", 100);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("ttsTextOf(TTS 정화)", () => {
  it("마커 제거·펜스 제외·프론트매터 제외", () => {
    const md = `---\ntitle: 메타\n---\n\n# 제목입니다\n\n**굵게**와 \`code\` 그리고 [[위키|링크]].\n\n\`\`\`js\nconsole.log(1);\n\`\`\`\n\n- 항목 하나\n`;
    expect(ttsTextOf(md)).toBe("제목입니다\n굵게와 code 그리고 링크.\n• 항목 하나");
  });
});

describe("ttsTextOf 표 처리", () => {
  it("표 줄은 셀 나열로, 구분 행은 생략", () => {
    const md = "| 항목 | 값 |\n|---|---|\n| 사과 | 3개 |\n";
    expect(ttsTextOf(md)).toBe("항목, 값\n사과, 3개");
  });
});

describe("ttsTextOf 가로선", () => {
  it("--- · *** · ___ 줄은 생략", () => {
    expect(ttsTextOf("위\n\n---\n\n아래")).toBe("위\n아래");
    expect(ttsTextOf("***\n")).toBe("");
  });
});

describe("ttsTextOf 각주", () => {
  it("정의 줄은 콜론 없이 본문만, 참조는 사라진다", () => {
    expect(ttsTextOf("본문[^1] 끝\n\n[^1]: 각주 내용\n")).toBe("본문 끝\n각주 내용");
  });
});
