// 표 자동 정렬 포맷터 — 파이프 열 맞춤(Typora·Obsidian "표 서식").
// 원문은 표 내용이 보존된 채 들여쓰기만 다시 배열된다: 셀 trim·열 개수
// 통일(짧은 행은 빈 셀 패딩)·전각(한글 등) 너비 반영 패딩·구분 행 정렬
// 표시(:--) 보존. 이스케이프된 \| 는 셀 구분이 아니다.

/** 표시 폭 — 전각/한글은 2, 나머지 1(모노 서체 근사). 순수 함수. */
export function cellWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || // 한글 자모
      (c >= 0x2e80 && c <= 0xa4cf) || // CJK 부호·한자
      (c >= 0xac00 && c <= 0xd7a3) || // 한글 음절
      (c >= 0xf900 && c <= 0xfaff) || // 한글 호환 자모
      (c >= 0xff00 && c <= 0xff60) || // 전각 형식
      (c >= 0xfe30 && c <= 0xfe4f);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 이스케이프를 존중해 행을 셀로 나눈다(양끝 파이프는 제거). */
function splitRow(line: string): string[] {
  const t = line.trim();
  const body = t.startsWith("|") ? t.slice(1) : t;
  const body2 = body.endsWith("|") && !body.endsWith("\\|") ? body.slice(0, -1) : body;
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < body2.length; i++) {
    if (body2[i] === "\\" && body2[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (body2[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += body2[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function pad(text: string, width: number): string {
  const gap = width - cellWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

/** 구분 행 셀(:---, :--:, ---:)의 정렬 표시 추출. */
function delimiterCell(align: "left" | "center" | "right" | null, width: number): string {
  const w = Math.max(3, width);
  const left = align === "left" || align === "center" ? ":" : "-";
  const right = align === "right" || align === "center" ? ":" : "-";
  return left + "-".repeat(Math.max(1, w - 2)) + right;
}

/** 표 텍스트를 정렬된 형태로(무손실: 셀 내용·정렬 표시 유지).
 *  입력이 표가 아니거나 바뀐 게 없으면 null(디스패치 생략). */
export function formatTableText(tableText: string): string | null {
  const lines = tableText.replace(/\n$/, "").split("\n");
  if (lines.length < 2) return null;
  const rows = lines.map(splitRow);
  // 두 번째 줄이 구분 행인지(-와 콜론만).
  const isDelim = (cells: string[]) =>
    cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
  if (!isDelim(rows[1])) return null;
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols < 1) return null;
  const aligns: Array<"left" | "center" | "right" | null> = [];
  for (let c = 0; c < cols; c++) {
    const cell = rows[1][c] ?? "";
    const l = cell.startsWith(":");
    const r = cell.endsWith(":");
    aligns.push(l && r ? "center" : r ? "right" : l ? "left" : null);
  }
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 0;
    for (let r = 0; r < rows.length; r++) {
      if (r === 1) continue;
      w = Math.max(w, cellWidth(rows[r][c] ?? ""));
    }
    widths.push(w);
  }
  const out = rows.map((row, r) => {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const cell = row[c] ?? "";
      if (r === 1) cells.push(delimiterCell(aligns[c], widths[c]));
      else if (aligns[c] === "right") {
        const gap = widths[c] - cellWidth(cell);
        cells.push(gap > 0 ? " ".repeat(gap) + cell : cell);
      } else if (aligns[c] === "center") {
        const gap = Math.max(0, widths[c] - cellWidth(cell));
        const l = Math.floor(gap / 2);
        cells.push(" ".repeat(l) + cell + " ".repeat(gap - l));
      } else cells.push(pad(cell, widths[c]));
    }
    return `| ${cells.join(" | ")} |`;
  });
  const result = out.join("\n") + (tableText.endsWith("\n") ? "\n" : "");
  return result === tableText ? null : result;
}

/** 문서 전체의 표를 정리 — 표 블록(파이프 줄 연속)을 찾아 각각
 *  formatTableText 적용. 비표 줄은 그대로. 순수 함수(테스트 대상). */
export function formatAllTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  const isRow = (l: string): boolean => {
    const t = l.trim();
    return t.startsWith("|") && t.endsWith("|") && t.length > 1;
  };
  while (i < lines.length) {
    if (isRow(lines[i]!)) {
      let j = i;
      while (j < lines.length && isRow(lines[j]!)) j++;
      const block = lines.slice(i, j).join("\n");
      const fmt = formatTableText(block);
      out.push(fmt ?? block);
      i = j;
    } else {
      out.push(lines[i]!);
      i += 1;
    }
  }
  return out.join("\n");
}

/** 문서 정리 — 3줄+ 빈 줄 → 1줄, 끝 연속 빈 줄 제거, 표 정렬.
 *  줄 끝 공백은 강제줄바꿈(두 칸)일 수 있어 건드리지 않는다. 순수 함수. */
export function tidyDocument(text: string): string {
  const tabled = formatAllTables(text);
  const collapsed = tabled.replace(/\n{3,}/g, "\n\n");
  const trimmedEnd = collapsed.replace(/\n+$/, "\n");
  return trimmedEnd;
}
