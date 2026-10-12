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
