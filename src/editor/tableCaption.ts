// 표 캡션(Pandoc 규약) — 표 바로 다음 줄의 ": 캡션"을 exports에서
// '표 N — 캡션'으로. 원문은 그대로(§4-2) — 해석은 내보내기 시에만.
// 순수 함수 — HTML 후처리와 테스트가 공유.

/** 표 다음 <p>: 캡션</p>을 <figure><table…/><figcaption>표 N — 캡션</figcaption></figure>로.
 *  빈 줄 하나까지 허용(markdown-it이 표와 문단 사이에 줄바꿈을 남길 수 있음). */
export function applyTableCaptions(html: string): string {
  let n = 0;
  return html.replace(
    /(<table\b[\s\S]*?<\/table>)(\s*)<p>:\s*([\s\S]*?)<\/p>/g,
    (_m, table: string, gap: string, cap: string) => {
      const text = cap.trim();
      if (!text) return `${table}${gap}<p>:</p>`;
      n += 1;
      return `<figure class="tbl-fig" id="tbl-${n}">${table}<figcaption>표 ${n} — ${cap}</figcaption></figure>`;
    },
  );
}

/** 마크다운 원문에서 표 캡션 후보 — 라이브 프리뷰·검증용. 순수 함수.
 *  표(파이프 줄) 바로 다음 줄이 ": "로 시작하면 {line, text}. */
export function tableCaptionLines(md: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const lines = md.split("\n");
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!isTableLine(lines[i]!)) continue;
    // 연속 표 확인 — 마지막 표 줄 찾기.
    let j = i;
    while (j + 1 < lines.length && (isTableLine(lines[j + 1]!) || isSepLine(lines[j + 1]!))) j++;
    // 빈 줄 하나까지 허용(HTML 변환과 같은 규칙 — markdown-it와 정합).
    let cand = j + 1;
    if (!(lines[cand] ?? "").trim() && (lines[cand + 1] ?? "").trim().startsWith(":")) {
      cand += 1;
    }
    const next = lines[cand] ?? "";
    const m = /^:\s+(.+)$/.exec(next.trim());
    if (m) {
      out.push({ line: cand + 1, text: m[1]! }); // 1-기반 줄 번호
      i = cand;
    }
  }
  return out;
}

function isTableLine(l: string): boolean {
  const t = l.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

function isSepLine(l: string): boolean {
  return /^\|[\s:|-]+\|$/.test(l.trim());
}
