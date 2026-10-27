// YAML 프론트매터(문서 시작의 --- … ---) — lezer 문법 확장 + 순수 유틸.
// 문법만 여기서 만들고 표시는 livePreview 장식, 통계·내보내기는
// stripFrontMatter로 본문만 남겨 쓴다(Obsidian 방식).

import type { MarkdownExtension } from "@lezer/markdown";

/** 문서 시작 프론트매터 — 본문 제거와 내보내기 메타가 같은 범위를 따른다. */
const FM_SCAN = /^(---\r?\n)((?:[^\n]*\n)*?)(---(?:\r?\n|$))/;

/** 프론트매터를 떼어낸 본문(없으면 원문 그대로). */
export function stripFrontMatter(text: string): string {
  return text.replace(FM_SCAN, "");
}

/** 프론트매터 길이(끝 오프셋). 없으면 0.
 *  전문 스캔 — 정규식이 '^' 고정이라 FM 없는 문서는 즉시 실패한다. 스캔
 *  길이 제한을 쓰면 긴 FM에서 0이 나와 stripFrontMatter(전문
 *  스캔)과 어긋난다(통계가 FM을 본문으로 세는 불일치). */
export function frontMatterLen(text: string): number {
  const m = text.match(FM_SCAN);
  return m ? m[0].length : 0;
}

/** 내보내기용 메타 — title·author·date(있는 것만). 순수 함수. */
export interface FrontMatterMeta {
  title: string;
  author: string;
  date: string;
  /** 네이티브 목차 요청(toc: true / toc: yes / toc: 1). */
  toc: boolean;
  /** 그림 목차(lof: true) — 캡션 SEQ Figure 목록. */
  lof: boolean;
  /** 표 목차(lot: true) — 캡션 SEQ Table 목록. */
  lot: boolean;
  /** EPUB 표지(false면 첫 이미지도 표지 안 씀). */
  cover: boolean;
  /** 다단(1~3) — Word Layout > Columns. */
  columns: number;
  /** 머리글 자유 텍스트 — 내보내기 머리글(제목 기본값 대체). */
  header: string;
  /** 바닥글 자유 텍스트 — 쪽번호와 함께 표시. */
  footer: string;
}

/** 프론트매터에서 title/author/date 추출(대소문자 무시). 없으면 null. */
export function frontMatterMeta(text: string): Partial<FrontMatterMeta> | null {
  const m = text.match(FM_SCAN);
  if (!m) return null;
  const yaml = m[2];
  const out: Partial<FrontMatterMeta> = {};
  for (const [k, v] of parseFrontMatter(yaml)) {
    if (!v) continue;
    const key = k.toLowerCase();
    if (key === "title" && !out.title) out.title = v;
    else if ((key === "author" || key === "authors") && !out.author) out.author = v;
    else if (key === "date" && !out.date) out.date = v;
    else if (key === "toc") out.toc = /^(true|yes|1)$/i.test(v);
    else if (key === "lof") out.lof = /^(true|yes|1)$/i.test(v);
    else if (key === "lot") out.lot = /^(true|yes|1)$/i.test(v);
    else if (key === "cover") out.cover = !/^(false|no|0)$/i.test(v);
    else if (key === "columns") {
      const n = parseInt(v, 10);
      if (n >= 1 && n <= 3) out.columns = n;
    } else if (key === "header" && !out.header) out.header = v;
    else if (key === "footer" && !out.footer) out.footer = v;
  }
  if (!out.toc) delete out.toc;
  if (!out.lof) delete out.lof;
  if (!out.lot) delete out.lot;
  if (out.cover !== false) delete out.cover;
  return Object.keys(out).length > 0 ? out : null;
}

/** 표시용 key·value 행 — 깊은 YAML은 다루지 않는다(간단한 스칼라·목록만).
 *  "- 항목" 줄은 앞 키의 값에 이어 붙인다. 순수 함수(테스트 대상). */
function scalarParts(raw: string): { value: string; comment: string } {
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (quote === '"' && ch === "\\") { i++; continue; }
      if (ch === quote) {
        if (quote === "'" && raw[i + 1] === "'") i++;
        else quote = "";
      }
    } else if ((ch === '"' || ch === "'") && !raw.slice(0, i).trim()) quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
      let start = i;
      while (start > 0 && /[ \t]/.test(raw[start - 1])) start--;
      return { value: raw.slice(0, start).trim(), comment: raw.slice(start) };
    }
  }
  return { value: raw.trim(), comment: "" };
}

function scalarText(raw: string): string {
  const { value } = scalarParts(raw);
  if (value.startsWith('"') && value.endsWith('"')) {
    try { const decoded: unknown = JSON.parse(value); if (typeof decoded === "string") return decoded; }
    catch { /* Existing YAML escapes outside JSON's subset remain display text. */ }
    return value.slice(1, -1);
  }
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value;
}

export function parseFrontMatter(yaml: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let lastKey = "";
  for (const raw of yaml.split("\n")) {
    const line = raw.trim();
    if (!line || line === "---" || line.startsWith("#")) continue;
    if (line.startsWith("- ") && lastKey) {
      const item = scalarText(line.slice(2));
      const prev = out[out.length - 1];
      prev[1] = prev[1] ? `${prev[1]} · ${item}` : item;
      continue;
    }
    const i = line.indexOf(":");
    if (i <= 0) {
      out.push(["", line]);
      lastKey = "";
      continue;
    }
    const key = line.slice(0, i).trim();
    const value = scalarText(line.slice(i + 1));
    out.push([key, value]);
    lastKey = key;
  }
  return out;
}

/** 닫는 --- 을 소비 없이 미리 찾는다 — 파서가 줄을 삼키면 되돌릴 수
 *  없으므로(스트리밍 블록 파싱) 결정은 소비 전에 끝내야 한다. 공개 API
 *  peekLine은 한 줄뿐이라 peekLine이 쓰는 같은 원시 함수 scanLine로
 *  위치를 옮겨가며 읽는다(@lezer/markdown 내부 API — 없으면 종전처럼
 *  닫는 --- 없이도 프론트매터로 보는 탐욕 fallback). 빈 줄도 text가
 *  ""라 EOF와 구분이 안 되니 그냥 건너뛰고 줄 수 상한(1024)으로만 봉쇄.
 *  FM_SCAN과 같은 '닫는 --- 필수' 규칙이라 파서·렌더·내보내기가 일치한다. */
let warnedScanLineMissing = false;
function hasClosingFence(cx: unknown, lineStart: number, lineLen: number): boolean {
  const scan = (cx as { scanLine?: (pos: number) => { text: string } }).scanLine;
  if (typeof scan !== "function") {
    // @lezer/markdown 내부 API(scanLine)가 사라졌다(버전 업) — 종전의
    // 탐욕 동작으로 폴백하되 개발 중 알아채도록 한 번만 경고한다(2026-10-24
    // 검토: 조용히 변질되면 문서 첫 줄 --- 회귀를 원인 파악 없이 겪게 된다.
    // 검증 버전: @lezer/markdown 2.x — peekLine 구현 참조).
    if (!warnedScanLineMissing) {
      warnedScanLineMissing = true;
      console.warn("[iyagi] @lezer/markdown scanLine 없음 — 프론트매터 닫는 --- 미리보기 폴백 동작");
    }
    return true;
  }
  let pos = lineStart + lineLen + 1; // 다음 줄 시작(현재 줄 개행 건너뜀)
  for (let i = 0; i < 1024; i++) {
    const r = scan.call(cx, pos);
    if (/^---\s*$/.test(r.text)) return true;
    if (r.text) pos += r.text.length + 1;
    else pos += 1; // 빈 줄 또는 EOF — 한 칸씩 전진
  }
  return false;
}

export const frontMatterSyntax: MarkdownExtension = {
  defineNodes: [{ name: "FrontMatter", block: true }],
  parseBlock: [
    {
      name: "iyagiFrontMatter",
      before: "HorizontalRule",
      parse(cx, line) {
        // 문서 첫 줄의 --- 만 프론트매터다(시작에서만 유효 — Jekyll·Obsidian 규칙).
        if (cx.lineStart !== 0 || !/^---\s*$/.test(line.text.slice(line.pos))) return false;
        // 닫는 --- 이 있어야 프론트매터다. 없으면 false를 돌려 이 줄을
        // HorizontalRule(수평선)이 파싱하게 비켜준다(2026-10-20 보고 —
        // 문서 첫 줄 --- 입력이 구분선으로 안 보이고 문서 전체가
        // 프론트매터로 삼켜졌다).
        if (!hasClosingFence(cx, cx.lineStart, line.text.length)) return false;
        const from = 0;
        let end = line.text.length;
        // 닫는 --- 줄까지 소비. eager leaf 규칙(mathBlock 주석 참조): 닫는 줄을
        // 찾으면 nextLine()으로 한 번 더 지나간다 — 어기면 그 뒤 문서가 사라진다.
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          if (/^---\s*$/.test(line.text.slice(line.pos))) {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("FrontMatter", from, Math.max(end, from + 3)));
        return true;
      },
    },
  ],
};


/** 프런트매터 키 값 갱신 — 다른 줄은 그대로(순서·주석 보존).
 *  null이면 그 키 삭제. 블록이 없으면(패치 비었지 않으면) 새로 만든다.
 *  바뀐 문자열은 JSON 호환 YAML 따옴표로 기록한다. 일반 YAML 재직렬화는
 *  하지 않으며, 최상위 단순 키와 그 값의 들여쓴 연속 줄만 편집한다. */
export function upsertFrontMatter(
  text: string,
  patch: Record<string, string | boolean | null>,
): string {
  const canonical = (key: string) => key.toLowerCase() === "authors" ? "author" : key.toLowerCase();
  const entries = new Map(Object.entries(patch).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [canonical(key), value]));
  if (!entries.size) return text;
  const m = text.match(FM_SCAN);
  const fmt = (value: string | boolean): string => typeof value === "boolean" ? String(value) : JSON.stringify(value);
  if (!m) {
    const eol = text.match(/\r?\n/)?.[0] ?? "\n";
    const lines = [...entries].filter((entry): entry is [string, string | boolean] => entry[1] !== null);
    if (!lines.length) return text;
    return `---${eol}${lines.map(([key, value]) => `${key}: ${fmt(value)}`).join(eol)}${eol}---${eol}${eol}${text}`;
  }
  const eol = m[1].slice(3);
  const kept: string[] = [];
  const seen = new Set<string>();
  let replacing = false;
  for (const line of m[2].match(/[^\n]*\n/g) ?? []) {
    const parts = /^([A-Za-z_][\w-]*):[ \t]*(.*?)(\r?\n)$/.exec(line);
    const key = parts ? canonical(parts[1]) : undefined;
    if (key !== undefined) replacing = entries.has(key);
    if (parts && key !== undefined && replacing) {
      if (!seen.has(key)) {
        seen.add(key);
        const value = entries.get(key)!;
        if (value !== null) {
          const spelling = parts[1].toLowerCase() === "authors" ? "author" : parts[1];
          const comment = scalarParts(parts[2]).comment;
          kept.push(`${spelling}: ${fmt(value)}${comment.startsWith("#") ? " " : ""}${comment}${parts[3]}`);
        }
      }
      continue;
    }
    // Replacing an author list or block scalar must consume its old value too.
    // Blank lines and comments remain; unrelated fields retain their exact bytes.
    const content = line.replace(/\r?\n$/, "");
    if (replacing && content.trim() && !content.trimStart().startsWith("#")) {
      if (/^[ \t]/.test(content) || /^-[ \t]/.test(content)) continue;
      replacing = false;
    }
    kept.push(line);
  }
  for (const [k, v] of entries) {
    if (!seen.has(k) && v !== null) kept.push(`${k}: ${fmt(v)}${eol}`);
  }
  return m[1] + kept.join("") + m[3] + text.slice(m[0].length);
}
