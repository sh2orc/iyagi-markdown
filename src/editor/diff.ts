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

/** 두 문서의 공통 접두·접미를 뺀 최소 교체 구간. 포맷터처럼 결과 전체를 새로
 *  만든 편집을 이 구간으로 디스패치하면 커서·스크롤이 제자리에 남는다
 *  (전체 교체는 커서를 문서 맨 앞으로 보낸다). */
export function minimalChange(oldText: string, newText: string): { from: number; to: number; insert: string } {
  const max = Math.min(oldText.length, newText.length);
  let from = 0;
  while (from < max && oldText.charCodeAt(from) === newText.charCodeAt(from)) from++;
  let tail = 0;
  while (tail < max - from && oldText.charCodeAt(oldText.length - 1 - tail) === newText.charCodeAt(newText.length - 1 - tail)) tail++;
  return { from, to: oldText.length - tail, insert: newText.slice(from, newText.length - tail) };
}

interface Hunk { from: number; to: number; lines: string[] }

/** base → next 의 줄 단위 교체 구간들(base 줄 번호 기준, 오름차순). */
function hunksBetween(base: string[], next: string[]): Hunk[] {
  const out: Hunk[] = [];
  let at = 0;
  let open: Hunk | null = null;
  for (const op of diffLcs(base, next)) {
    // 같은 종류의 연속 줄은 한 항으로 합쳐져 온다(줄바꿈으로 이어 붙임).
    const lines = op.text.split("\n");
    if (op.kind === "same") {
      open = null;
      at += lines.length;
      continue;
    }
    if (!open) {
      open = { from: at, to: at, lines: [] };
      out.push(open);
    }
    if (op.kind === "del") {
      at += lines.length;
      open.to = at;
    } else {
      open.lines.push(...lines);
    }
  }
  return out;
}

/** 3방향 병합(줄 단위) — 공통 원본 base에서 갈라진 mine·theirs를 합친다.
 *  두 쪽이 서로 다른 곳을 고쳤으면 합친 본문을, 같은 곳(맞닿은 줄 포함)을 다르게
 *  고쳤으면 null(사용자 판단 필요)을 돌려준다. 같은 곳을 똑같이 고친 것은 한 번만
 *  반영한다. 열려 있는 문서가 밖에서 바뀌었을 때 미저장 편집을 잃지 않고 바로
 *  따라가기 위한 것 — 애매하면 합치지 않는다. */
export function merge3(base: string, mine: string, theirs: string): string | null {
  if (mine === theirs || base === theirs) return mine;
  if (base === mine) return theirs;
  const baseLines = base.split("\n");
  const a = hunksBetween(baseLines, mine.split("\n"));
  const b = hunksBetween(baseLines, theirs.split("\n"));
  const out: string[] = [];
  let at = 0;
  let i = 0;
  let j = 0;
  const take = (hunk: Hunk): void => {
    for (let n = at; n < hunk.from; n++) out.push(baseLines[n]!);
    out.push(...hunk.lines);
    at = hunk.to;
  };
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x && y && x.from <= y.to && y.from <= x.to) {
      // 같은 자리 — 똑같은 수정이면 한 번만, 아니면 충돌.
      if (x.from !== y.from || x.to !== y.to || x.lines.join("\n") !== y.lines.join("\n")) return null;
      take(x);
      i += 1;
      j += 1;
    } else if (x && (!y || x.from < y.from)) {
      take(x);
      i += 1;
    } else {
      take(y!);
      j += 1;
    }
  }
  for (let n = at; n < baseLines.length; n++) out.push(baseLines[n]!);
  return out.join("\n");
}
