// relPath 회귀 — 이미지 붙여넣기 이중 assets/ 버그(11차 수정) 방지.

import { describe, expect, it } from "vitest";

import { relPath } from "./paths";

describe("relPath", () => {
  it("하위 디렉터리 경로를 포함한다 — 호출자가 접두를 다시 붙이면 안 된다", () => {
    expect(relPath("/w/docs", "/w/docs/assets/paste-1.png")).toBe("assets/paste-1.png");
    expect(relPath("/w/docs", "/w/docs/a.md")).toBe("a.md");
  });

  it("상위로 올라가는 경로", () => {
    expect(relPath("/w/docs", "/w/img.png")).toBe("../img.png");
    expect(relPath("/w/docs/sub", "/w/img.png")).toBe("../../img.png");
    // 루트 바로 밑 파일 — 후행 빈 세그먼트 정규화(예전엔 "../a.md"가 나왔다).
    expect(relPath("/", "/a.md")).toBe("a.md");
    expect(relPath("/", "/sub/a.md")).toBe("sub/a.md");
    expect(relPath("/w/docs/", "/w/docs/a.md")).toBe("a.md");
  });

  it("공통 없으면 위로 타고 간다(루트만 공유)", () => {
    expect(relPath("/a", "/b/x.png")).toBe("../b/x.png");
  });
});
