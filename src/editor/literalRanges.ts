// 글자 그대로인 구간(코드 펜스·인라인 코드) 찾기 — 순수 텍스트 스캔.
// 원문을 정규식으로 다시 쓰는 변환(위키링크 → 링크, 임베드 인라인, 태그 추출)이
// 코드 안의 `[[ -f x ]]`·`#include` 같은 글자를 문법으로 오인하지 않게 한다.
// 파서(lezer)를 끌어오지 않는다 — 내보내기 청크를 가볍게 유지.

export type Range = readonly [from: number, to: number];

const FENCE_OPEN = /^[ \t>]*(`{3,}|~{3,})/;

/** 코드 펜스(``` / ~~~)와 인라인 코드의 [from, to) 구간들(오름차순, 겹침 없음).
 *  펜스는 같은 문자·같거나 더 긴 길이의 닫는 줄에서만 닫힌다(~~~ 안의 ```는 내용). */
export function literalRanges(text: string): Range[] {
  const out: Array<[number, number]> = [];
  let pos = 0;
  let fence: { char: string; len: number; from: number } | null = null;
  let proseFrom = 0;
  const inlineIn = (from: number, to: number): void => {
    // 인라인 코드 — 백틱 n개로 열고 정확히 n개로 닫는다(빈 줄은 넘지 않는다).
    const seg = text.slice(from, to);
    let i = 0;
    while (i < seg.length) {
      if (seg[i] !== "`") { i++; continue; }
      let n = 1;
      while (seg[i + n] === "`") n++;
      let j = i + n;
      let close = -1;
      while (j < seg.length) {
        if (seg[j] === "\n" && /^[ \t]*(\n|$)/.test(seg.slice(j + 1))) break;
        if (seg[j] !== "`") { j++; continue; }
        let m = 1;
        while (seg[j + m] === "`") m++;
        if (m === n) { close = j; break; }
        j += m;
      }
      if (close < 0) { i += n; continue; }
      out.push([from + i, from + close + n]);
      i = close + n;
    }
  };
  for (const line of text.split("\n")) {
    const lineEnd = pos + line.length;
    if (fence) {
      const m = FENCE_OPEN.exec(line);
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && line.slice(m[0].length).trim() === "") {
        out.push([fence.from, lineEnd]);
        fence = null;
        proseFrom = Math.min(lineEnd + 1, text.length);
      }
    } else {
      const m = FENCE_OPEN.exec(line);
      // 백틱 펜스의 정보 문자열에는 백틱이 올 수 없다(그건 인라인 코드다).
      if (m && !(m[1][0] === "`" && line.slice(m[0].length).includes("`"))) {
        inlineIn(proseFrom, pos);
        fence = { char: m[1][0]!, len: m[1].length, from: pos };
      }
    }
    pos = lineEnd + 1;
  }
  if (fence) out.push([fence.from, text.length]);
  else inlineIn(proseFrom, text.length);
  return out.sort((a, b) => a[0] - b[0]);
}

/** pos가 구간들 중 하나 안인가(구간은 오름차순). */
export function inRanges(ranges: readonly Range[], pos: number): boolean {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = ranges[mid]!;
    if (pos < from) hi = mid - 1;
    else if (pos >= to) lo = mid + 1;
    else return true;
  }
  return false;
}
