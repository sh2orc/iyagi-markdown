// i18n 무결성 — 키 누락 방지. 사전 하나에 키를 추가하면 반대쪽이 빠지는
// 실수를 테스트가 잡는다.

import { describe, expect, it } from "vitest";

import { detectLang, langFromTag, makeT } from "./i18n";

describe("i18n", () => {
  it("ko/en 사전 키가 정확히 같다", async () => {
    // 사전 내부를 직접 비교하기 위해 모듈을 다시 연다(export 구조상 t로 확인).
    const en = makeT("en");
    const ko = makeT("ko");
    const enKeys = Object.keys(en).filter((k) => k !== "f" && typeof en[k as never] === "string");
    const koKeys = Object.keys(ko).filter((k) => k !== "f" && typeof ko[k as never] === "string");
    expect(new Set(enKeys)).toEqual(new Set(koKeys));
    for (const key of enKeys) {
      expect((ko as unknown as Record<string, string>)[key].length, `ko 번역 없음: ${key}`).toBeGreaterThan(0);
    }
  });

  it("언어 감지", () => {
    expect(detectLang(["fr-FR", "ko-KR", "en-US"])).toBe("ko");
    expect(detectLang(["en-US", "ko-KR"])).toBe("en");
    expect(detectLang(["zh-Hans"])).toBe("en");
    expect(detectLang([])).toBe("en");
    expect(langFromTag("ko_KR")).toBe("ko");
    expect(langFromTag("en")).toBe("en");
    expect(langFromTag("ja")).toBeNull();
  });
});
