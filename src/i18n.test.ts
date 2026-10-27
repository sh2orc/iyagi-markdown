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

  it("ko/en 형식화 함수(f) 키도 정확히 같다", () => {
    // 한쪽 로캘에만 형식화 함수를 추가하면 반대쪽 렌더에서 t.f.x(...)가
    // undefined 호출로 죽는다 — 문자열 패리티 검사가 f를 제외하므로 따로 잠근다.
    const en = makeT("en").f;
    const ko = makeT("ko").f;
    expect(new Set(Object.keys(en))).toEqual(new Set(Object.keys(ko)));
    for (const key of Object.keys(en)) {
      expect(typeof (ko as unknown as Record<string, unknown>)[key], `ko 형식화 없음: ${key}`).toBe("function");
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
