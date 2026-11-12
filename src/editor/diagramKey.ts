// mermaid 다이어그램 표시 폭의 안정적 키 — 줄 번호는 편집으로 밀리므로 코드
// 내용으로 식별한다(표의 헤더 키와 같은 원칙). 순수 함수 — 편집기 위젯·사이드카·
// 내보내기가 같은 규칙을 공유한다. 줄 단위로 다듬어 목록 안 들여쓴 펜스나
// 줄 끝 공백 차이에도 같은 키가 나오게 한다(DOCX diagram_key와 같은 정규화).

/** 다이어그램 코드 → 사이드카 키(FNV-1a 32비트, "m" 접두). */
export function diagramKey(code: string): string {
  const norm = code
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `m${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** 다이어그램 폭(%) 허용 범위 — 너무 작으면 핸들을 다시 잡기 어렵다. */
export const DIAGRAM_MIN_PCT = 10;

export function clampDiagramPct(pct: number): number {
  return Math.min(100, Math.max(DIAGRAM_MIN_PCT, Math.round(pct)));
}
