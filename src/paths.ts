// 경로 문자열 유틸(Tauri 없이 순수하게 — 테스트 가능).

/** POSIX 경로의 디렉터리 부분("/a/b.md" → "/a"). 빈 문자열이면 "."를 돌려준다. */
export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  if (i < 0) return ".";
  if (i === 0) return "/";
  return p.slice(0, i);
}
