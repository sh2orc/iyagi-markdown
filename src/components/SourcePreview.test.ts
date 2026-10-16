// 소스 모드 분할 미리보기 — 스크롤 비례 매핑(순수).

import { describe, expect, it } from "vitest";

import { syncedScrollTop } from "./SourcePreview";

describe("syncedScrollTop", () => {
  it("비례 매핑 — 절반 스크롤은 절반", () => {
    expect(
      syncedScrollTop(
        { scrollTop: 500, scrollHeight: 2000, clientHeight: 1000 },
        { scrollHeight: 4000, clientHeight: 1000 },
      ),
    ).toBe(1500);
  });

  it("맨 위·맨 아래 클램프", () => {
    const from = { scrollTop: 0, scrollHeight: 2000, clientHeight: 1000 };
    expect(syncedScrollTop(from, { scrollHeight: 4000, clientHeight: 1000 })).toBe(0);
    const bottom = { scrollTop: 1000, scrollHeight: 2000, clientHeight: 1000 };
    expect(syncedScrollTop(bottom, { scrollHeight: 3000, clientHeight: 1000 })).toBe(2000);
  });

  it("스크롤 여지가 없으면 0", () => {
    expect(
      syncedScrollTop({ scrollTop: 40, scrollHeight: 1000, clientHeight: 1000 }, { scrollHeight: 500, clientHeight: 500 }),
    ).toBe(0);
  });
});
