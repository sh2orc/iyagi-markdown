// 끊긴 위키링크 검사(Obsidian "broken links") — 현재 문서의 [[이름]] 중
// 워크스페이스 인덱스가 모르는 것. 순수 함수(테스트 대상).

import { parseWikiLink } from "./wiki";

export interface BrokenLink {
  /** 1부터 시작하는 줄 번호. */
  line: number;
  name: string;
  /** 원문 등장 위치(문서 오프셋). */
  from: number;
}

/** text의 [[..]] 중 resolve(name)이 null인 것들. 펜스 안은 건너뛴다. */
export function brokenWikiLinks(
  text: string,
  resolve: (name: string) => string | null,
): BrokenLink[] {
  const out: BrokenLink[] = [];
  let inFence = false;
  let fence = "";
  let pos = 0;
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const t = line.trimStart();
    if (/^(```|~~~)/.test(t)) {
      const mark = t.slice(0, 3);
      if (!inFence) {
        inFence = true;
        fence = mark;
      } else if (mark === fence) {
        inFence = false;
      }
    }
    if (!inFence) {
      let idx = line.indexOf("[[");
      while (idx !== -1) {
        const close = line.indexOf("]]", idx + 2);
        if (close === -1) break;
        const raw = line.slice(idx, close + 2);
        const { name } = parseWikiLink(raw);
        if (name && !resolve(name)) {
          out.push({ line: li + 1, name, from: pos + idx });
        }
        idx = line.indexOf("[[", close + 2);
      }
    }
    pos += line.length + 1;
  }
  return out;
}


/** 끊긴 파일 링크·이미지 — [텍스트](rel)·![alt](rel) 중 워크스페이스에
 *  없는 상대 경로 대상. http(s)·data:·mailto:·#앵커·절대 경로는 건너뛴다.
 *  exists(path)는 패널이 트리/인덱스로 공급. 순수 함수(테스트 대상). */
export function brokenFileLinks(
  text: string,
  exists: (path: string) => boolean,
  baseDir: string,
): BrokenLink[] {
  const out: BrokenLink[] = [];
  let inFence = false;
  let fence = "";
  let pos = 0;
  let lineNo = 0;
  for (const line of text.split("\n")) {
    lineNo += 1;
    const lineStart = pos;
    pos += line.length + 1;
    const t = line.trimStart();
    if ((t.startsWith("\`\`\`") || t.startsWith("~~~")) && t.length >= 3) {
      const f = t.slice(0, 3);
      if (!inFence) {
        inFence = true;
        fence = f;
      } else if (f === fence) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const re = /!?\[((?:[^\[\]]|\\.)*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
    for (const m of line.matchAll(re)) {
      const raw = m[2]!;
      if (/^(https?:|data:|mailto:|#|tel:)/i.test(raw)) continue;
      if (raw.startsWith("/")) continue; // 절대 경로 — 판단 보류
      const clean = raw.split("#")[0]!.split("?")[0]!;
      if (!clean) continue;
      const full = baseDir ? `${baseDir}/${clean.replace(/^\.\//, "")}` : clean;
      if (!exists(full)) {
        out.push({ line: lineNo, name: raw, from: lineStart + (m.index ?? 0) });
      }
    }
  }
  return out;
}
