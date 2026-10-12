// 경로 문자열 유틸(Tauri 없이 순수하게 — 테스트 가능).

/** POSIX 경로의 디렉터리 부분("/a/b.md" → "/a"). 빈 문자열이면 "."를 돌려준다. */
export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return p.slice(0, i);
}

/** baseDir 기준 상대 경로(같은 트리면 상대로, 아니면 절대 유지). */
export function relPath(baseDir: string, absPath: string): string {
  const base = baseDir.split("/");
  const abs = absPath.split("/");
  let i = 0;
  while (i < base.length && i < abs.length && base[i] === abs[i]) i++;
  if (i === 0) return absPath;
  const up = base.length - i;
  const rest = abs.slice(i).join("/");
  return (up === 0 ? "" : "../".repeat(up)) + rest;
}
