// 호버 미리보기 텍스트 준비 테스트 — 제목 추출·마커 정리·길이 제한의 정확성.

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import {
  cachedLinkPreview,
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
    rememberLinkPreview("/a", { title: "A", body: "a" });
    rememberLinkPreview("/b", { title: "B", body: "b" });
    expect(cachedLinkPreview("/a")?.title).toBe("A"); // LRU 순서 갱신
    for (let i = 0; i < 29; i++) rememberLinkPreview(`/x${i}`, { title: `X${i}`, body: "" });
    expect(cachedLinkPreview("/b")).toBeNull(); // 갱신 안 한 b가 밀려남
    expect(cachedLinkPreview("/a")?.title).toBe("A"); // a는 살아남
    invalidateLinkPreviews("/a");
    expect(cachedLinkPreview("/a")).toBeNull();
    rememberLinkPreview("/z", { title: "Z", body: "" });
    invalidateLinkPreviews();
    expect(cachedLinkPreview("/z")).toBeNull();
  });
});
