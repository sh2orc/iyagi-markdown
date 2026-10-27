// 줄 단위 diff — LCS(최장 공통 부분수열) 기반. 문서 비교 뷰용.
// 순수 함수 — DP 크기를 제한하고 큰 문서는 공통 접두·접미 사이를 통째로
// 교체한다. 어느 경로든 원본·결과 전체를 빠짐없이 표현한다.

export type DiffOp = { kind: "same" | "add" | "del"; text: string };

/** a(왼쪽/원본)와 b(오른쪽/새 문서)의 줄 diff. */
export function diffLines(aText: string, bText: string): DiffOp[] {
  const a = aText.split("\n");
  const b = bText.split("\n");
  return diffLcs(a, b);
}

/** 고전 LCS DP — 표 크기를 제한한 O(n·m) 비교. */
function diffLcs(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // 경계 행·열을 포함해 최대 4M칸(약 16MB). 초과 시 중앙 영역을 통째로 교체.
  if ((n + 1) * (m + 1) > 4_000_000) {
    return trimmedDiff(a, b);
  }
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(out, "same", a[i]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      push(out, "del", a[i]);
      i++;
    } else {
      push(out, "add", b[j]);
      j++;
    }
  }
  while (i < n) push(out, "del", a[i++]);
  while (j < m) push(out, "add", b[j++]);
  return out;
}

/** 큰 입력은 공통 접두·접미를 보존하고 가운데를 교체한다(최소 diff는 아님). */
function trimmedDiff(a: string[], b: string[]): DiffOp[] {
  const out: DiffOp[] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    push(out, "same", a[start]);
    start++;
  }
  let ae = a.length;
  let be = b.length;
  while (ae > start && be > start && a[ae - 1] === b[be - 1]) {
    ae--;
    be--;
  }
  // 같은 문자열이 있다는 이유만으로 same 처리하면 중복·이동된 줄이
  // 결과에 두 번 들어간다. 큰 중앙 영역은 정확한 삭제+추가로 표현한다.
  for (let i = start; i < ae; i++) push(out, "del", a[i]);
  for (let j = start; j < be; j++) push(out, "add", b[j]);
  for (let k = be; k < b.length; k++) push(out, "same", b[k]);
  return out;
}

/** 같은 종류의 연속 항은 합친다(뷰 노드 수 절감). */
function push(out: DiffOp[], kind: DiffOp["kind"], text: string): void {
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += "\n" + text;
  else out.push({ kind, text });
}

/** 요약 — 추가/삭제 줄 수. */
export function diffSummary(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added += op.text.split("\n").length;
    else if (op.kind === "del") removed += op.text.split("\n").length;
  }
  return { added, removed };
}
