// 목차 트리 — 플랫 제목을 부모-자식 트리로, 접기 상태에서 보이는 항목 계산.
// 순수 함수 — TocPanel 렌더와 테스트가 공유한다.

import type { Heading } from "../links";

export interface TocNode {
  heading: Heading;
  /** 플랫 목록 인덱스(스크롤 스파이 activeIdx와의 대응). */
  idx: number;
  /** 표시 깊이 — 중간 수준 생략(h1→h3)은 당겨서 겹침 없이. */
  depth: number;
  children: TocNode[];
  /** 하위 제목 수(전체 — 접힘 배지용). */
  descendantCount: number;
}

/** 플랫 제목 → 트리. 같은 수준이 오면 형제, 낮아지면 부모 복귀. */
export function tocTree(headings: Heading[]): TocNode[] {
  const roots: TocNode[] = [];
  // 스택: [표시깊이, 노드] — 실제 level이 아니라 이전 항목의 관계만 필요.
  const stack: Array<{ depth: number; node: TocNode }> = [];
  headings.forEach((h, idx) => {
    // 스택에서 나보다 깊거나 같은 수준을 pop — 남는 게 부모.
    while (stack.length > 0 && stack[stack.length - 1]!.node.heading.level >= h.level) stack.pop();
    const parent = stack[stack.length - 1];
    // 표시 깊이 — 부모의 관계 깊이 + 1(중간 수준 생략 반영).
    const depth = parent ? parent.depth + 1 : 0;
    const node: TocNode = { heading: h, idx, depth, children: [], descendantCount: 0 };
    if (parent) parent.node.children.push(node);
    else roots.push(node);
    stack.push({ depth, node });
  });
  // 하위 수 채우기(후위).
  const fill = (n: TocNode): number => {
    n.descendantCount = n.children.reduce((acc, c) => acc + fill(c) + 1, 0);
    return n.descendantCount;
  };
  for (const r of roots) fill(r);
  return roots;
}

/** 접힌 노드(slug 집합)에서 보이는 노드의 평면 나열(위→아래). */
export function visibleNodes(roots: TocNode[], collapsedSlugs: Set<string>): TocNode[] {
  const out: TocNode[] = [];
  const walk = (nodes: TocNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.children.length > 0 && !collapsedSlugs.has(n.heading.slug)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/** 노드의 조상 slug 집합(활성 항목의 경로 표시용). */
export function ancestorSlugs(roots: TocNode[], slug: string): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: TocNode[], trail: TocNode[]): boolean => {
    for (const n of nodes) {
      if (n.heading.slug === slug) {
        for (const a of trail) out.add(a.heading.slug);
        return true;
      }
      if (walk(n.children, [...trail, n])) return true;
    }
    return false;
  };
  walk(roots, []);
  return out;
}

/** 제목 필터 — 대소문자 무시 부분 일치. 빈 쿼리는 null(필터 아님). */
export function filterHeadings(headings: Heading[], q: string): Heading[] | null {
  const query = q.trim().toLowerCase();
  if (!query) return null;
  return headings.filter((h) => h.text.toLowerCase().includes(query));
}

/** 위치의 제목 경로(조상 체인) — 상태 줄 브레드크럼. 스택으로 수준 유지. */
export function headingPath(headings: Heading[], pos: number): Heading[] {
  const stack: Heading[] = [];
  for (const h of headings) {
    if (h.pos > pos) break;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack;
}

/** 중복 슬러그 제목 — GitHub식 -1 접미로 앵커가 갈라지는 것들. 순수 함수. */
export function duplicateHeadings(headings: Heading[]): Array<{ text: string; pos: number }> {
  const seen = new Map<string, number>();
  const out: Array<{ text: string; pos: number }> = [];
  for (const h of headings) {
    const n = (seen.get(h.slug) ?? 0) + 1;
    seen.set(h.slug, n);
    if (n === 2) out.push({ text: h.text, pos: h.pos });
  }
  return out;
}
