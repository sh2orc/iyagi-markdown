// mermaid 렌더 큐 — 다이어그램 하나당 mermaid.render는 정확히 한 번, 고유 id로.
// (2026-11-12 버그: 큐가 첫 작업을 꺼내지 않고 실행해 같은 id로 두 번 렌더 →
// 편집기에 붙은 SVG에 두 번째 그림이 덧그려져 노드가 거대하게 겹쳐 보였다.)

import { beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.fn(async (id: string, code: string) => {
  await new Promise((r) => setTimeout(r, 5));
  if (code.includes("BROKEN")) throw new Error("parse error");
  return { svg: `<svg id="${id}"><g class="root"></g></svg>` };
});

vi.mock("mermaid", () => ({
  default: { initialize: vi.fn(), render },
}));

beforeEach(() => {
  render.mockClear();
});

describe("renderMermaid 렌더 큐", () => {
  it("단일 다이어그램은 mermaid.render를 한 번만 부른다", async () => {
    const { renderMermaid } = await import("./mermaid");
    const r = await renderMermaid("graph TD; A-->B;", "light");
    await new Promise((res) => setTimeout(res, 30));
    expect(r.error).toBeNull();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("동시에 몰린 다이어그램은 각각 한 번씩, 서로 다른 id로 순차 렌더한다", async () => {
    const { renderMermaid } = await import("./mermaid");
    const codes = ["graph TD; C-->D;", "graph TD; E-->F;", "graph TD; G-->H;"];
    const results = await Promise.all(codes.map((c) => renderMermaid(c, "light")));
    await new Promise((res) => setTimeout(res, 30));
    expect(results.every((r) => r.svg !== null)).toBe(true);
    expect(render).toHaveBeenCalledTimes(codes.length);
    const ids = render.mock.calls.map((c) => c[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("실패한 렌더 뒤에도 큐가 계속 돈다", async () => {
    const { renderMermaid } = await import("./mermaid");
    const [bad, good] = await Promise.all([
      renderMermaid("graph TD; BROKEN", "light"),
      renderMermaid("graph TD; X-->Y;", "light"),
    ]);
    expect(bad.svg).toBeNull();
    expect(bad.error).toBe("parse error");
    expect(good.svg).not.toBeNull();
    await new Promise((res) => setTimeout(res, 30));
    expect(render).toHaveBeenCalledTimes(2);
  });
});
