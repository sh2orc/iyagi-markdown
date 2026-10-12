// 표 열 폭의 안정적 키 — 줄 번호 키는 편집으로 밀리므로 헤더 내용으로 식별한다.
// 순수 함수(CodeMirror 의존 없음) — 에디터 렌더·사이드카·내보내기가
// 같은 키 규칙을 공유한다. 프런트매터 제거 등 줄 이동과 무관.

/** 마크다운 표 원문 첫 줄(헤더) → 셀 텍스트 배열. */
export function mdHeaderCells(tableSrc: string): string[] {
  const first = tableSrc.split("\n", 1)[0] ?? "";
  const body = first.replace(/^\s*\|/, "").replace(/\|\s*$/, "");
  return body.split("|").map(normalizeCell);
}

/** 렌더된 HTML <table> 조각 → 첫 <tr>의 th/td 텍스트 배열. */
export function htmlHeaderCells(tableHtml: string): string[] {
  const tr = /<tr[^>]*>([\s\S]*?)<\/tr>/i.exec(tableHtml)?.[1] ?? "";
  const cells: string[] = [];
  const re = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const m of tr.matchAll(re)) cells.push(normalizeCell(stripTags(m[2])));
  return cells;
}

/** 셀 정규화 — 공백 제거 + 강조 마커 제거 + 엔티티 복원
 *  (렌더 결과와 원문이 같은 키를 갖게). */
function normalizeCell(s: string): string {
  return stripTags(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, "");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

/** 셀 배열 → 키. 같은 구조(열 수 포함)의 표만 같은 키를 가진다. */
export function cellsKey(cells: string[]): string {
  return cells.join("\x1f").slice(0, 200);
}

/** 마크다운 표 원문 → 키. */
export function mdTableKey(tableSrc: string): string {
  return cellsKey(mdHeaderCells(tableSrc));
}

/** 렌더된 HTML 표 → 키. */
export function htmlTableKey(tableHtml: string): string {
  return cellsKey(htmlHeaderCells(tableHtml));
}
