// TSV → 마크다운 표 변환 — 엑셀·Numbers·구글 시트 표를 붙여넣으면 그대로
// 표가 된다(Word가 엑셀 표를 표로 붙이는 것과 같은 동작). 순수 함수.

/** TSV 모양인가 — 2줄 이상, 대부분의 줄에 탭 1개 이상. 순수 함수. */
export function looksLikeTsv(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return false;
  const tabbed = lines.filter((l) => l.includes("\t")).length;
  return tabbed >= Math.ceil(lines.length * 0.8);
}

/** 셀 텍스트 이스케이프 — 파이프만. 순수 함수. */
function escCell(s: string): string {
  return s.trim().replace(/\|/g, "\\|");
}

/** TSV → 마크다운 표 문자열. 첫 줄을 헤더로, 나머지는 데이터.
 *  열 수는 첫 줄 기준(초과 열은 뒤에 합침, 부족 열은 빈 칸). 순수 함수. */
export function tsvToTable(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return "";
  const rows = lines.map((l) => l.split("\t"));
  const cols = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => {
    const out = r.map(escCell);
    while (out.length < cols) out.push("");
    return out;
  });
  const header = norm[0]!;
  const sep = Array.from({ length: cols }, () => "---");
  const body = norm.slice(1);
  return [header, sep, ...body].map((r) => `| ${r.join(" | ")} |`).join("\n");
}
