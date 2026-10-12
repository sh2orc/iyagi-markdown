// YAML 프론트매터(문서 시작의 --- … ---) — lezer 문법 확장 + 순수 유틸.
// 문법만 여기서 만들고 표시는 livePreview 장식, 통계·내보내기는
// stripFrontMatter로 본문만 남겨 쓴다(Obsidian 방식).

import type { MarkdownExtension } from "@lezer/markdown";

/** 문서 시작 프론트매터 정규식 — 앞 2KB만 대상으로 스캔한다(항상 문서 첫머리). */
const FM_SCAN = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;
const SCAN_LIMIT = 2048;

function head(text: string): string {
  return text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
}

/** 프론트매터를 떼어낸 본문(없으면 원문 그대로). */
export function stripFrontMatter(text: string): string {
  return text.replace(FM_SCAN, "");
}

/** 프론트매터 길이(끝 오프셋). 없으면 0. */
export function frontMatterLen(text: string): number {
  const m = head(text).match(FM_SCAN);
  return m ? m[0].length : 0;
}

/** 내보내기용 메타 — title·author·date(있는 것만). 순수 함수. */
export interface FrontMatterMeta {
  title: string;
  author: string;
  date: string;
}

/** 프론트매터에서 title/author/date 추출(대소문자 무시). 없으면 null. */
export function frontMatterMeta(text: string): Partial<FrontMatterMeta> | null {
  const m = head(text).match(FM_SCAN);
  if (!m) return null;
  const yaml = m[0].replace(/^---\r?\n/, "").replace(/\r?\n---(?:\r?\n|$)/, "");
  const out: Partial<FrontMatterMeta> = {};
  for (const [k, v] of parseFrontMatter(yaml)) {
    if (!v) continue;
    const key = k.toLowerCase();
    if (key === "title" && !out.title) out.title = v;
    else if ((key === "author" || key === "authors") && !out.author) out.author = v;
    else if (key === "date" && !out.date) out.date = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 표시용 key·value 행 — 깊은 YAML은 다루지 않는다(간단한 스칼라·목록만).
 *  "- 항목" 줄은 앞 키의 값에 이어 붙인다. 순수 함수(테스트 대상). */
export function parseFrontMatter(yaml: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let lastKey = "";
  for (const raw of yaml.split("\n")) {
    const line = raw.trim();
    if (!line || line === "---") continue;
    if (line.startsWith("- ") && lastKey) {
      const item = line.slice(2).trim().replace(/^["']|["']$/g, "");
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
    const value = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    out.push([key, value]);
    lastKey = key;
  }
  return out;
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
