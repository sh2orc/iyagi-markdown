// 섹션 이동 — 개요(목차 패널) 드래그 재배치의 순수 계산.
// 섹션 = 제목 시작 ~ 다음 동급·상위 제목 전(또는 문서 끝). 한 번의 트랜잭션으로
// 원문 블록을 옮긴다(undo 1단계, 원문 무손실 원칙은 텍스트 이동일 뿐).

import type { Heading } from "../links";

export interface SectionRange {
  from: number;
  to: number;
}

/** 제목 배열에서 idx번 제목의 섹션 범위(제목 포함, 끝은 다음 동급/상위 제목 전).
 *  섹션 앞의 빈 줄은 포함하지 않는다(이동 뒤 줄 잔여 최소화). */
export function sectionRange(headings: Heading[], idx: number, docLength: number): SectionRange | null {
  const h = headings[idx];
  if (!h) return null;
  let end = docLength;
  for (let i = idx + 1; i < headings.length; i++) {
    if (headings[i]!.level <= h.level) {
      end = headings[i]!.pos;
      break;
    }
  }
  return { from: h.pos, to: end };
}

/** 이동 트랜잭션 계산 — srcIdx 섹션을 dstIdx 제목 **앞**으로.
 *  반환: CM 변경 배열 + 새 커서. src→dst가 같거나 제자리(효과 없음)면 null. */
export function moveSection(
  headings: Heading[],
  srcIdx: number,
  dstIdx: number,
  docLength: number,
): { from: number; to: number; insertAt: number; cursor: number } | null {
  if (srcIdx === dstIdx || srcIdx < 0 || dstIdx < 0) return null;
  const src = sectionRange(headings, srcIdx, docLength);
  const dst = headings[dstIdx];
  if (!src || !dst) return null;
  const dstPos = dst.pos;
  // 목적지가 src 범위 안(자기 섹션 내부)이면 무의미.
  if (dstPos > src.from && dstPos < src.to) return null;
  // 삽입 위치가 src 삭제로 밀리면 보정.
  const insertAt = dstPos > src.from ? dstPos - (src.to - src.from) : dstPos;
  return { from: src.from, to: src.to, insertAt, cursor: insertAt };
}

/** 섹션 텍스트(이동용) — 끝의 빈 줄들을 잘라 이동 잔여를 남기지 않는다. */
export function trimSectionForMove(text: string): { text: string; cut: number } {
  const m = /\s+$/.exec(text);
  return { text: text.slice(0, m?.index ?? text.length), cut: m ? m[0].length : 0 };
}
