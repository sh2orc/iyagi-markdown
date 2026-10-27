// 그래프 뷰 — 화살표 노드 이동(순수) — 로빙 tabindex 키보드 탐색.

import { describe, expect, it } from "vitest";

import { nearestNodeInDirection, zoomAt } from "./GraphView";

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

describe("zoomAt (그래프 줌 — 순수)", () => {
  it("고정점 보존 — 줌인/아웃 모두 고정점 좌표 불변", () => {
    const z = zoomAt(1, 0, 0, 300, 200, 1.25);
    expect(z.k).toBe(1.25);
    expect(z.tx).toBeCloseTo(300 - 300 * 1.25);
    // 고정점 역변환: (c - t)/k = 원래 (300 - 0)/1
    expect((300 - z.tx) / z.k).toBeCloseTo(300);
    expect((200 - z.ty) / z.k).toBeCloseTo(200);
    const zo = zoomAt(2, 10, 20, 50, 60, 0.5);
    expect(zo.k).toBe(1);
    expect((50 - zo.tx) / zo.k).toBeCloseTo((50 - 10) / 2);
    expect((60 - zo.ty) / zo.k).toBeCloseTo((60 - 20) / 2);
  });

  it("클램프 — 0.4~6 범위 밖으로 나가지 않는다", () => {
    expect(zoomAt(5.5, 0, 0, 0, 0, 2).k).toBe(6);
    expect(zoomAt(0.5, 0, 0, 0, 0, 0.5).k).toBe(0.4);
  });
});

import { buildGraph, layout } from "./GraphView";
import { AppStore, type StoreIO } from "../app/store";

describe("그래프의 문서 경로", () => {
  it("해석된 대상만 연결하고 중복·자기 참조·트리 밖 끝점을 제외한다", () => {
    const io: StoreIO = {
      readDocument: async () => ({ text: "", meta: { hadBom: false, crlf: false }, mtime: 1, size: 0 }),
      writeDocument: async () => ({ mtime: 1, size: 0 }), scanWorkspace: async () => ({ tree: [], issues: [] }),
      saveSession: async () => {}, setAssetScope: async () => {}, watchPaths: async () => {},
    };
    const store = new AppStore(io);
    store.state.tree = ["a", "b"].map((dir) => ({ kind: "dir" as const, name: dir, path: `/w/${dir}`, children: [
      { kind: "file" as const, name: "note.md", stem: "note", path: `/w/${dir}/note.md` },
      { kind: "file" as const, name: "ref.md", stem: "ref", path: `/w/${dir}/ref.md` },
    ] }));
    const graph = buildGraph(store, [
      { from: "/w/b/ref.md", to: "/w/b/note.md" },
      { from: "/w/b/ref.md", to: "/w/b/note.md" },
      { from: "/w/a/ref.md", to: "/w/b/note.md" },
      { from: "/w/a/ref.md", to: "note" }, // An unresolved name is never reinterpreted.
      { from: "/w/a/ref.md", to: "/w/a/ref.md" },
      { from: "/outside/ref.md", to: "/w/b/note.md" },
      { from: "/w/a/ref.md", to: "/outside/note.md" },
    ]);
    expect(graph.edges).toEqual([
      { from: "/w/b/ref.md", to: "/w/b/note.md" },
      { from: "/w/a/ref.md", to: "/w/b/note.md" },
    ]);
    expect(graph.nodes.find((node) => node.id === "/w/a/note.md")?.degree).toBe(0);
    expect(graph.nodes.find((node) => node.id === "/w/b/note.md")?.degree).toBe(2);
  });

  it("큰 그래프에서는 문서를 생략하지 않고 원형 좌표를 유지한다", () => {
    const nodes = Array.from({ length: 251 }, (_, i) => ({
      id: `/w/${i}.md`, name: `${i}`, degree: 0, x: i, y: i + 1, vx: 0, vy: 0,
    }));
    const before = nodes.map((node) => ({ ...node }));
    layout(nodes, [{ from: nodes[0].id, to: nodes[1].id }]);
    expect(nodes).toEqual(before);
  });
});
