// 그래프 뷰 — 화살표 노드 이동(순수) — 로빙 tabindex 키보드 탐색.

import { describe, expect, it } from "vitest";

import { nearestNodeInDirection } from "./GraphView";

const N = [
  { id: "c", x: 0, y: 0 }, // 기준
  { id: "r1", x: 10, y: 1 }, // 오른쪽 가깝·살짝 어긋남
  { id: "r2", x: 50, y: 0 }, // 오른쪽 멀리·정렬
  { id: "u", x: 2, y: -10 }, // 위 가깝·어긋남
  { id: "l", x: -30, y: 0 }, // 왼쪽
];

describe("nearestNodeInDirection", () => {
  it("오른쪽 — 수직 어긋남 벌점으로 가까운 쪽이 이긴다", () => {
    // r1: 3·1²+10=13 < r2: 3·0+50=50
    expect(nearestNodeInDirection(N, "c", 1, 0)).toBe("r1");
  });

  it("위 — 어긋남 적은 것이 멀리 정렬된 것을 이긴다", () => {
    // u: 3·2²+10=22 vs r2(위 아님) — 방향 어긋난 노드는 후보가 아님
    expect(nearestNodeInDirection(N, "c", 0, -1)).toBe("u");
  });

  it("반대편 노드는 후보에서 제외 — 해당 방향이 비면 null", () => {
    expect(nearestNodeInDirection(N, "r2", 1, 0)).toBeNull();
  });

  it("기준 노드가 목록에 없으면 null", () => {
    expect(nearestNodeInDirection(N, "없음", 1, 0)).toBeNull();
  });
});
