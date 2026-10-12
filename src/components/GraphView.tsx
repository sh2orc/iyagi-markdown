// 그래프 뷰 — 문서 노드 + 위키링크 간선을 SVG로 렌더.
// 간단한 힘 기반 배치(3~4회 반복) — 대규모 그래프는 원형 폴백.
// 노드 크기 = 연결 수(차수), 활성 문서는 강조.

import { useMemo, useState } from "react";

import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onOpen: (path: string) => void;
  /** Rust wiki_edges 결과(from 경로 → to 키). 없으면 빈 그래프. */
  wikiLinks?: Array<{ from: string; to: string }>;
}

interface GraphNode {
  id: string; // 경로
  name: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface GraphEdge {
  from: string;
  to: string;
}

/** 그래프 데이터 — 위키링크 인덱스(스토어)에서.
 *  간선: 문서 A가 [[B]]를 참조하면 A→B 간선. */
function buildGraph(store: AppStore, wikiLinks?: Array<{ from: string; to: string }>): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const tree = store.state.tree;
  const edges: GraphEdge[] = [];
  const nodeSet = new Set<string>();
  const nameOf = new Map<string, string>();

  // 파일에서 노드 수집.
  const walk = (nodes: typeof tree): void => {
    for (const n of nodes) {
      if (n.kind === "file") {
        nodeSet.add(n.path);
        nameOf.set(n.path, n.stem ?? n.name);
      } else if (n.kind === "dir") {
        walk(n.children ?? []);
      }
    }
  };
  walk(tree);

  // 간선: 위키링크가 실제 파일을 가리키는 것만.
  // wikiIndex: Map<key, paths[]> — key에서 경로로 매핑.
  const byStem = new Map<string, string[]>();
  for (const n of nodeSet) {
    const stem = nameOf.get(n) ?? "";
    const arr = byStem.get(stem) ?? [];
    arr.push(n);
    byStem.set(stem, arr);
  }
  // 실제 위키링크 간선 — Rust wiki_edges가 문서 내용에서 [[키]]를 추출.
  // 키를 경로로 해석: stem 또는 상대경로 매칭.
  const fileList = [...nodeSet];
  const keyToPaths = new Map<string, string[]>();
  for (const p of fileList) {
    const name = nameOf.get(p) ?? "";
    const stem = name.replace(/\.(md|markdown)$/i, "");
    for (const key of [stem, name]) {
      const arr = keyToPaths.get(key) ?? [];
      arr.push(p);
      keyToPaths.set(key, arr);
    }
  }
  if (wikiLinks) {
    for (const e of wikiLinks) {
      const targets = keyToPaths.get(e.to) ?? [];
      for (const t of targets) {
        if (e.from !== t && nodeSet.has(e.from) && nodeSet.has(t)) {
          edges.push({ from: e.from, to: t });
        }
      }
    }
  }

  // 차수 계산.
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  // 초기 배치: 원형.
  const W = 600;
  const H = 400;
  const nodes: GraphNode[] = fileList.map((path, i) => {
    const angle = (2 * Math.PI * i) / Math.max(fileList.length, 1);
    return {
      id: path,
      name: nameOf.get(path) ?? path,
      degree: degree.get(path) ?? 0,
      x: W / 2 + Math.cos(angle) * (W / 3),
      y: H / 2 + Math.sin(angle) * (H / 3),
      vx: 0,
      vy: 0,
    };
  });

  return { nodes, edges };
}

/** 간단 힘 기반 배치 — 4회 반복(좌표는 px). */
function layout(nodes: GraphNode[], edges: GraphEdge[], iterations = 4): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let iter = 0; iter < iterations; iter++) {
    // 척력(모든 쌍이 멀어지려는 힘).
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1) continue;
        const f = 2000 / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
    // 인력(연결된 노드가 가까워지려는 힘).
    for (const e of edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1) continue;
      const f = d * 0.02;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    // 감쇠 + 이동 + 경계.
    for (const n of nodes) {
      n.vx *= 0.5;
      n.vy *= 0.5;
      n.x = Math.max(30, Math.min(570, n.x + n.vx));
      n.y = Math.max(20, Math.min(380, n.y + n.vy));
    }
  }
}

export function GraphView({ store, t, onClose, onOpen, wikiLinks }: Props): JSX.Element | null {
  const [selected, setSelected] = useState<string | null>(null);
  const { nodes, edges } = useMemo(() => {
    const g = buildGraph(store, wikiLinks);
    if (g.nodes.length > 2) layout(g.nodes, g.edges);
    return g;
  }, [store, store.state.tree]);

  const activePath = store.active?.path ?? null;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const maxDegree = Math.max(...nodes.map((n) => n.degree), 1);

  // 노드 크기: 차수 비례(4~12px).
  const radius = (n: GraphNode): number => 4 + (n.degree / maxDegree) * 8;

  return (
    <div className="overlay modal-overlay" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="graph-frame">
        <div className="print-head">
          <span className="print-title">{t.graphTitle}</span>
          <span className="graph-count">
            {nodes.length} {t.graphDocs} · {edges.length} {t.graphLinks}
          </span>
          <button className="btn btn-plain" onClick={onClose}>
            {t.close}
          </button>
        </div>
        <div className="graph-body">
          {nodes.length === 0 ? (
            <div className="palette-empty">{t.wsSearchNoFolder}</div>
          ) : (
            <svg viewBox="0 0 600 400" className="graph-svg" width="100%" height="100%">
              {/* 간선 */}
              {edges.map((e, i) => {
                const a = byId.get(e.from);
                const b = byId.get(e.to);
                if (!a || !b) return null;
                const isSel = selected === e.from || selected === e.to;
                return (
                  <line
                    key={i}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className={`graph-edge ${isSel ? "is-hl" : ""}`}
                  />
                );
              })}
              {/* 노드 */}
              {nodes.map((n) => {
                const isActive = n.id === activePath;
                const isSel = selected === n.id;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x},${n.y})`}
                    onClick={() => setSelected(n.id)}
                    onDoubleClick={() => onOpen(n.id)}
                    className={`graph-node ${isActive ? "is-active" : ""} ${isSel ? "is-sel" : ""}`}
                  >
                    <circle r={radius(n)} />
                    {n.degree > 0 && (
                      <text y={radius(n) + 12} textAnchor="middle" className="graph-label">
                        {n.name.length > 12 ? `${n.name.slice(0, 10)}…` : n.name}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        {selected && (
          <div className="graph-detail">
            <button className="btn btn-primary" onClick={() => onOpen(selected)}>
              {byId.get(selected)?.name}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
