// 인용·서지(Word References의 마크다운 판) — 순수 파싱/번호부여.
// 문법(pandoc 참조·각주 혼합 규약):
//   본문:   [@key] · [@key, p. 12]   → [1] · [1, p. 12](첫 등장 순 번호)
//   서지:   [@key]: Smith, J. (2020). *Title*.  (한 줄 정의 — 각주 규약과 동일 어감)
// 의존성 없음(편집기·내보내기 공유).

export interface CiteDef {
  /** 정의 줄 번호(1 기준). */
  line: number;
  /** 키 뒤 전체 항목 텍스트. */
  entry: string;
}

export interface CitationNumbering {
  /** 키 → 정의. */
  defs: Map<string, CiteDef>;
  /** 첫 등장 순 키 목록(정의 없는 키 포함 — 끊긴 인용 표시용). */
  order: string[];
  /** 정의된 키 → 번호(1 기준). */
  num: Map<string, number>;
}

/** 코드 펜스를 제외한 줄 목록(줄 번호 보존). */
function nonFenceLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let fence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (/^\s*(```|~~~)/.test(t)) fence = !fence;
    if (!fence) out.push({ line: i + 1, text: t });
  }
  return out;
}

const DEF_RE = /^\s*\[@([^\]\s]+)\]:\s*(.*)$/;
/** 인라인 인용 — 키(쉼표 앞)+접미사(선택). `[[@a]]` 형태의 중첩은 무시. */
const CITE_RE = /\[@([^\][\s]+)(?:,\s*([^\]]*))?\]/g;

export function parseCiteDefs(text: string): Map<string, CiteDef> {
  const defs = new Map<string, CiteDef>();
  for (const { line, text: t } of nonFenceLines(text)) {
    const m = DEF_RE.exec(t);
    if (m) defs.set(m[1], { line, entry: m[2] });
  }
  return defs;
}

/** 문서 전체 인용 스캔 — 첫 등장 순 번호(정의된 키만 번호를 받는다). */
export function citeNumbering(text: string): CitationNumbering {
  const defs = parseCiteDefs(text);
  const order: string[] = [];
  const seen = new Set<string>();
  const src = nonFenceLines(text).map((l) => l.text).join("\n");
  // 정의 줄 자체는 인용 출현에서 제외(정의 안의 [@..] 재귀 무시).
  const body = src
    .split("\n")
    .filter((l) => !DEF_RE.test(l))
    .join("\n");
  CITE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CITE_RE.exec(body))) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      order.push(m[1]);
    }
  }
  const num = new Map<string, number>();
  let n = 0;
  for (const k of order) {
    if (defs.has(k)) num.set(k, ++n);
  }
  return { defs, order, num };
}

/** 인라인 인용 표시 문자열 — `[1]` · `[1, p. 12]` · 정의 없으면 null. */
export function citeDisplay(
  key: string,
  suffix: string | undefined,
  numbering: CitationNumbering,
): string | null {
  const n = numbering.num.get(key);
  if (n === undefined) return null;
  return suffix ? `[${n}, ${suffix}]` : `[${n}]`;
}

/** 정의 줄 판정(줄 장식용 — 펜스 제외는 호출쪽 codeRanges). */
export function isCiteDefLine(text: string): boolean {
  return DEF_RE.test(text);
}

/** 끊긴 인용(정의 없는 키의 사용처) — 문서 위치와 함께(첫 것으로 점프용).
 *  펜스 내부·정의 줄은 제외(nonFenceLines·citeNumbering과 같은 규칙). */
export function brokenCitations(text: string): Array<{ key: string; pos: number }> {
  const defs = parseCiteDefs(text);
  const out: Array<{ key: string; pos: number }> = [];
  let offset = 0;
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && !DEF_RE.test(line)) {
      CITE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CITE_RE.exec(line)) !== null) {
        if (!defs.has(m[1]!)) out.push({ key: m[1]!, pos: offset + m.index });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/** 전역 플래그 상태 없는 새 인용 정규식(스캔 호출마다 생성). */
export function citeRegExp(): RegExp {
  return /\[@([^\][\s]+)(?:,\s*([^\]]*))?\]/g;
}

/**
 * 정의 줄을 서지 문단 HTML로 치환(펜스 보존) — 내보내기 전처리.
 * markdown-it/comrak이 `[@key]: …`를 링크 참조 정의로 소비하기 때문에
 * 렌더 전에 원시 HTML로 바꾼다(각주 사전 변환과 같은 이유).
 */
export function citeDefsToHtml(
  text: string,
  numbering: CitationNumbering,
  esc: (s: string) => string,
): string {
  let fence = false;
  return text
    .split("\n")
    .map((t) => {
      if (/^\s*(```|~~~)/.test(t)) {
        fence = !fence;
        return t;
      }
      if (fence) return t;
      const m = DEF_RE.exec(t);
      if (!m) return t;
      const n = numbering.num.get(m[1]);
      const num = n !== undefined ? `<span class="ref-num">[${n}]</span> ` : "";
      return `<p class="ref-entry" id="ref-${esc(m[1])}">${num}${esc(m[2])}</p>`;
    })
    .join("\n");
}
