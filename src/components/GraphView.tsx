// 그래프 뷰 — 문서 노드 + 해석된 문서 간선을 SVG로 렌더.
// 간단한 힘 기반 배치(3~4회 반복) — 대규모 그래프는 원형 폴백.
// 노드 크기 = 연결 수(차수), 활성 문서는 강조.
// 줌(휠, 커서 고정)·팬(배경 드래그)·더블클릭 리셋 — 노드 밀집 대비.

import { useEffect, useMemo, useRef, useState } from "react";

import type { DocumentEdge } from "../api";
import type { AppStore } from "../app/store";
import type { Translate } from "../i18n";

interface Props {
  store: AppStore;
  t: Translate;
  onClose: () => void;
  onOpen: (path: string) => void;
  /** Rust document_edges 결과. 양 끝점 모두 실제 파일 경로. */
  links?: DocumentEdge[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
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

/** 대상 해석은 백링크와 동일한 서버 스캔에서 수행한다. */
export function buildGraph(store: AppStore, links?: DocumentEdge[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
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

  // 삭제/폴더 변경 후 늦은 결과에서도 현재 트리에 있는 양 끝점만 표시한다.
  const fileList = [...nodeSet];
  const seen = new Set<string>();
  for (const link of links ?? []) {
    if (link.to === link.from || !nodeSet.has(link.from) || !nodeSet.has(link.to)) continue;
    const key = JSON.stringify([link.from, link.to]);
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from: link.from, to: link.to });
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

/** 줌 적용(순수) — 고정점 c 주변으로 배율 k'·t' = c - (c - t)·k'/k.
 *  휠(커서 고정)·키보드(중앙 고정)가 같은 수식을 쓴다. */
export function zoomAt(
  k: number,
  tx: number,
  ty: number,
  cx: number,
  cy: number,
  factor: number,
): { k: number; tx: number; ty: number } {
  const k2 = Math.min(6, Math.max(0.4, k * factor));
  return {
    k: k2,
    tx: cx - (cx - tx) * (k2 / k),
    ty: cy - (cy - ty) * (k2 / k),
  };
}

/** 화살표 이동 — 방향 축으로 가장 가까운 노드(수직 오프셋 벌점).
 *  순수 함수(로빙 tabindex 키보드 탐색용 — 리스트 규약의 SVG 판). */
export function nearestNodeInDirection(
  nodes: Array<{ id: string; x: number; y: number }>,
  fromId: string,
  dx: -1 | 0 | 1,
  dy: -1 | 0 | 1,
): string | null {
  const from = nodes.find((n) => n.id === fromId);
  if (!from) return null;
  let best: { id: string; score: number } | null = null;
  for (const n of nodes) {
    if (n.id === fromId) continue;
    const ax = n.x - from.x;
    const ay = n.y - from.y;
    const parallel = ax * dx + ay * dy; // 방향 축 투영(진행 거리)
    if (parallel <= 0) continue; // 반대편·제자리 제외
    const perp = Math.abs(ax * dy - ay * dx); // 방향에 수직인 어긋남
    const score = perp * perp * 3 + parallel; // 정렬된 노드 우선
    if (best === null || score < best.score) best = { id: n.id, score };
  }
  return best?.id ?? null;
}

/** 간단 힘 기반 배치 — 4회 반복(좌표는 px). */
export function layout(nodes: GraphNode[], edges: GraphEdge[], iterations = 4): void {
  // Large workspaces keep their O(n) circular positions instead of O(n²) repulsion.
  if (nodes.length > 250) return;
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

export function GraphView({ store, t, onClose, onOpen, links, loading = false, error = null, onRetry }: Props): JSX.Element | null {
  const [selected, setSelected] = useState<string | null>(null);
  // 로빙 tabindex — 화살표로 노드 간 이동, Enter로 열기(리스트 키보드 규약의 SVG 판).
  const [focused, setFocused] = useState<string | null>(null);
  const nodeEls = useRef(new Map<string, SVGGElement>());
  // 뷰 상태 — viewBox 안에서 g transform으로 적용(줌·팬).
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const panRef = useRef<{ cx: number; cy: number; tx: number; ty: number } | null>(null);
  const { nodes, edges } = useMemo(() => {
    const g = buildGraph(store, links);
    if (g.nodes.length > 2) layout(g.nodes, g.edges);
    return g;
  }, [store, store.state.tree, links]);

  const activePath = store.active?.path ?? null;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const maxDegree = Math.max(...nodes.map((n) => n.degree), 1);

  // 노드 크기: 차수 비례(4~12px).
  const radius = (n: GraphNode): number => 4 + (n.degree / maxDegree) * 8;

  // 클라이언트 좌표 → viewBox 좌표(letterbox 보정 포함, 정확 변환).
  const toLocal = (cx: number, cy: number): { x: number; y: number } | null => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return null;
    const pt = svg.createSVGPoint();
    pt.x = cx;
    pt.y = cy;
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  // 휠 줌 — 네이티브 비수동 리스너로. React onWheel은 루트에서 passive 등록이라
  // preventDefault가 무시된다(콘솔 개입 경고 + 스크롤 가능 조상이 있으면 같이 굴러감).
  // setView 콜백 폼으로 최신 뷰 상태를 읽는다(리스너 등록 시점 클로저와 무관).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheelNative = (e: WheelEvent): void => {
      e.preventDefault();
      const c = toLocal(e.clientX, e.clientY);
      if (!c) return;
      // 커서 지점 고정 줌 — 수식은 zoomAt(키보드 줌과 공용).
      setView((v) => zoomAt(v.k, v.tx, v.ty, c.x, c.y, e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    svg.addEventListener("wheel", onWheelNative, { passive: false });
    return () => svg.removeEventListener("wheel", onWheelNative);
    // toLocal은 ref 기반(getScreenCTM)이라 안정. 노드가 비어 svg가 늦게
    // 마운트되는 경우도 덮는다(노드 0 → 렌더 후 재부착).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length === 0, loading, error]);

  const onPanStart = (e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest(".graph-node")) return;
    panRef.current = { cx: e.clientX, cy: e.clientY, tx: view.tx, ty: view.ty };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPanMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = panRef.current;
    if (!p) return;
    const a = toLocal(p.cx, p.cy);
    const b = toLocal(e.clientX, e.clientY);
    if (!a || !b) return;
    setView((v) => ({ ...v, tx: p.tx + (a.x - b.x), ty: p.ty + (a.y - b.y) }));
  };

  // 화살표 이동 — 상태 바꾸면 이펙트가 실제 포커스를 옮긴다.
  useEffect(() => {
    if (focused) nodeEls.current.get(focused)?.focus();
  }, [focused]);

  // 마운트 시 첫 노드 포커스 — 화살표 탐색이 열자마자 동작(모달 자체 포커스
  // 규약의 SVG 판 — 로빙 시작점). ref 콜백은 이펙트보다 먼저 채워진다.
  useEffect(() => {
    if (loading || error) return;
    const first = nodes.find((node) => node.id === focused) ?? nodes[0];
    if (first) {
      if (focused !== first.id) setFocused(first.id);
      nodeEls.current.get(first.id)?.focus();
    }
  }, [loading, error, nodes, focused]);

  const onSvgKey = (e: React.KeyboardEvent<SVGSVGElement>): void => {
    const dirs: Record<string, [-1 | 0 | 1, -1 | 0 | 1]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    // 키보드 줌 — 중앙 고정(+/-는 물리 키, 0은 리셋).
    if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0") {
      e.preventDefault();
      if (e.key === "0") {
        setView({ k: 1, tx: 0, ty: 0 });
        return;
      }
      const svg = svgRef.current;
      const box = svg?.getBoundingClientRect();
      const c = box ? toLocal(box.left + box.width / 2, box.top + box.height / 2) : { x: 300, y: 200 };
      if (!c) return;
      setView(zoomAt(view.k, view.tx, view.ty, c.x, c.y, e.key === "-" ? 1 / 1.25 : 1.25));
      return;
    }
    const dir = dirs[e.key];
    if (!dir) return;
    const cur = focused ?? nodes[0]?.id;
    if (!cur) return;
    e.preventDefault();
    const next = nearestNodeInDirection(nodes, cur, dir[0], dir[1]);
    if (next) {
      setFocused(next);
      setSelected(next); // 이동도 선택 피드백(클릭과 동일 — 상세 열기 버튼 갱신)
    }
  };

  return (
    <div className="overlay modal-overlay" role="dialog" aria-modal="true" aria-labelledby="document-graph-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="graph-frame">
        <div className="print-head">
          <span id="document-graph-title" className="print-title">{t.graphTitle}</span>
          <span className="graph-count">
            {nodes.length} {t.graphDocs}{!loading && !error && <> · {edges.length} {t.graphLinks}</>}
          </span>
          <button className="btn btn-plain" onClick={onClose}>
            {t.close}
          </button>
        </div>
        {!loading && !error && nodes.length > 250 && <p className="graph-layout-note">{t.graphLargeLayout}</p>}
        <div className="graph-body">
          {loading ? <div className="palette-empty" role="status">{t.loading}</div>
          : error ? <div className="palette-empty" role="alert"><p>{t.wikiLoadFailed}: {error}</p>
            <button className="btn" onClick={onRetry}>{t.wsRetry}</button></div>
          : nodes.length === 0 ? (
            <div className="palette-empty">{t.wsSearchNoFolder}</div>
          ) : (
            <svg
              ref={svgRef}
              viewBox="0 0 600 400"
              className="graph-svg"
              width="100%"
              height="100%"
              onPointerDown={onPanStart}
              onPointerMove={onPanMove}
              onPointerUp={() => {
                panRef.current = null;
              }}
              onKeyDown={onSvgKey}
              onDoubleClick={(e) => {
                // 배경 더블클릭 — 줌·팬 리셋(노드는 문서 열기).
                if (!(e.target as Element).closest(".graph-node")) setView({ k: 1, tx: 0, ty: 0 });
              }}
            >
              <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
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
              {nodes.map((n, i) => {
                const isActive = n.id === activePath;
                const isSel = selected === n.id;
                return (
                  <g
                    key={n.id}
                    ref={(el) => {
                      if (el) nodeEls.current.set(n.id, el);
                      else nodeEls.current.delete(n.id);
                    }}
                    transform={`translate(${n.x},${n.y})`}
                    tabIndex={focused === n.id || (focused === null && i === 0) ? 0 : -1}
                    role="button"
                    aria-label={n.name}
                    onClick={() => {
                      setSelected(n.id);
                      setFocused(n.id);
                    }}
                    onFocus={() => setFocused(n.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        onOpen(n.id);
                      }
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      onOpen(n.id);
                    }}
                    className={`graph-node ${isActive ? "is-active" : ""} ${isSel ? "is-sel" : ""}`}
                  >
                    <title>{n.id}</title>
                    <circle r={radius(n)} />
                    {n.degree > 0 && (
                      <text y={radius(n) + 12} textAnchor="middle" className="graph-label">
                        {n.name.length > 12 ? `${n.name.slice(0, 10)}…` : n.name}
                      </text>
                    )}
                  </g>
                );
              })}
              </g>
            </svg>
          )}
        </div>
        {!loading && !error && selected && byId.has(selected) && (
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
