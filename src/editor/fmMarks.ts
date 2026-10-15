// 서식 기호(¶) — Word '서식 기호 표시'의 마크다운 판.
// 공백 ·, 탭 →, 줄 끝 ¶ 를 문서 위치(UTF-16)로 계산하는 순수 함수.

export type FmMark =
  | { kind: "space" | "tab"; from: number; to: number }
  | { kind: "para"; from: number };

/**
 * 한 청크 텍스트의 서식 기호 위치. 코드 블록 제외는 호출쪽(codeRanges)에서.
 * 연속 공백도 한 칸씩 ·(Word와 같이 중복 공백이 눈에 보이게).
 */
export function formattingMarkRanges(
  text: string,
  offset: number,
): FmMark[] {
  const out: FmMark[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === " ") out.push({ kind: "space", from: offset + i, to: offset + i + 1 });
    else if (c === "\t") out.push({ kind: "tab", from: offset + i, to: offset + i + 1 });
    else if (c === "\n") out.push({ kind: "para", from: offset + i });
  }
  return out;
}
