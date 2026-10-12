// 줄 단위 diff — LCS(최장 공통 부분수열) 기반. 문서 비교 뷰용.
// 순수 함수 — 단위 테스트 대상. 대용량 안전: 줄 수 상한 두고 초과 시 접두
// 비교로 안전하게 떨어진다.

export type DiffOp = { kind: "same" | "add" | "del"; text: string };

const MAX_LINES = 12_000;

/** a(왼쪽/원본)와 b(오른쪽/새 문서)의 줄 diff. */
export function diffLines(aText: string, bText: string): DiffOp[] {
  const a = aText.split("\n");
  const b = bText.split("\n");
  if (a.length + b.length > MAX_LINES * 2) {
    // 상한 초과 — 앞부분만 비교하고 안내 항을 남긴다.
    const head = diffLcs(a.slice(0, MAX_LINES), b.slice(0, MAX_LINES));
    head.push({ kind: "add", text: `… (${a.length + b.length - 2 * MAX_LINES}+ 줄 생략 — 문서가 너무 큽니다)` });
    return head;
  }
  return diffLcs(a, b);
}

/** 고전 LCS DP — 줄 수 제한 안에서 O(n·m). 해시로 비교 비용 절감. */
function diffLcs(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  // 메모리: n·m 비트는 크다 — Int32Array 두 줄(롤링)로 LCS 길이만 계산 후
  // 역추적은 별도 경로 저장 없이 재귀 분할? 단순화: 전체 테이블은 n·m·4바이트.
  // 12k줄 상한에서 최악 12000×12000×4 = 576MB — 너무 크다. 실용 상한:
  // n·m ≤ 4M(≈2000×2000)일 때만 정밀 DP, 넘으면 트리밍(공통 접두/접미 제거 후
  // 중앙 휴리스틱). 마크다운 문서 비교 실용 범위에서 정밀 DP가 성립한다.
  if (n * m > 4_000_000) {
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

/** 공통 접두·접미를 잘라내고 가운데만 휴리스틱(순서 보존 매칭)으로 비교. */
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
  // 가운데 덩어리 — 줄 해시 맵으로 재정렬 감지(이동은 add+del로 나타난다).
  const bIndex = new Map<string, number>();
  for (let j = start; j < be; j++) {
    const k = bIndex.get(b[j]);
    if (k === undefined) bIndex.set(b[j], j);
  }
  for (let i = start; i < ae; i++) {
    if (bIndex.has(a[i])) push(out, "same", a[i]);
    else push(out, "del", a[i]);
  }
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
