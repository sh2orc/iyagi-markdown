// 링크·경로 해석 — crates/md-core/src/links.rs와 같은 규칙.
// 양쪽이 일치하는지는 코퍼스 테스트(links.test.ts ↔ Rust 테스트)로 검증한다.
// Tauri 의존 없이 순수하게 유지한다(단위 테스트·내보내기 공용).

export type LinkTarget =
  | { kind: "external"; url: string }
  | { kind: "mail"; url: string }
  | { kind: "anchor"; id: string }
  | { kind: "markdown"; path: string; anchor: string | null }
  | { kind: "asset"; path: string }
  | { kind: "other"; url: string };

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"]);

function joinDir(base: string, rel: string): string {
  if (rel.startsWith("/")) return lexicallyClean(rel);
  return lexicallyClean(`${base}/${rel}`);
}

/** `.`/`..` 정리(파일시스템 조회 없음). */
export function lexicallyClean(path: string): string {
  const abs = path.startsWith("/");
  const parts = path.split("/").filter((s) => s.length > 0 && s !== ".");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      // 루트 위로는 못 간다.
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
    } else {
      out.push(part);
    }
  }
  return (abs ? "/" : "") + out.join("/");
}

export function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    // 고립된 %만 이스케이프해 다시 시도.
    return decodeURIComponent(s.replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
  }
}

/** 마크다운 링크 대상을 문서 디렉터리 기준으로 분류한다. */
export function resolveLink(link: string, baseDir: string): LinkTarget {
  const trimmed = link.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("ftp://")) {
    return { kind: "external", url: trimmed };
  }
  if (lower.startsWith("mailto:")) return { kind: "mail", url: trimmed };
  if (trimmed.startsWith("#")) return { kind: "anchor", id: percentDecode(trimmed.slice(1)) };

  const hashIdx = trimmed.indexOf("#");
  const filePart = hashIdx >= 0 ? trimmed.slice(0, hashIdx) : trimmed;
  const anchor = hashIdx >= 0 ? percentDecode(trimmed.slice(hashIdx + 1)) : null;
  if (filePart === "") return { kind: "anchor", id: anchor ?? "" };

  if (trimmed.includes("://") || lower.startsWith("data:") || lower.startsWith("javascript:")) {
    return { kind: "other", url: trimmed };
  }
  const decoded = percentDecode(filePart).replace(/\\/g, "/");
  const path = joinDir(baseDir, decoded);
  const ext = path.substring(path.lastIndexOf(".") + 1).toLowerCase();
  if (MARKDOWN_EXTS.has(ext)) return { kind: "markdown", path, anchor };
  return { kind: "asset", path };
}

/** GitHub 방식 제목 슬러그(md-core의 slug_heading과 동일 규칙). */
export function slugifyHeading(text: string): string {
  let slug = "";
  for (const ch of text.trim()) {
    if (/\p{L}|\p{N}/u.test(ch)) slug += ch.toLowerCase();
    else if (/\s/.test(ch)) {
      if (!slug.endsWith("-")) slug += "-";
    }
  }
  slug = slug.replace(/^-+|-+$/g, "");
  return slug || "section";
}

/** 문서의 모든 제목에 슬러그를 붙인다. 중복은 GitHub처럼 `-1` 접미로 구분. */
export interface Heading {
  level: number;
  text: string;
  slug: string;
  /** 제목 줄의 첫 글자 위치(문서 오프셋) — TOC 클릭 스크롤용. */
  pos: number;
}

/** 원문 텍스트에서 제목을 뽑는다(코드 블록 안의 # 은 무시).
 *  에디터가 없는 경로(내보내기 앵커 계산 등)에서도 쓴다. */
export function collectHeadings(text: string): Heading[] {
  const seen = new Map<string, number>();
  const out: Heading[] = [];
  let inFence = false;
  let fence = "";
  let pos = 0;
  for (const line of text.split("\n")) {
    const lineStart = pos;
    pos += line.length + 1;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const marker = trimmed.slice(0, 3);
      if (!inFence) {
        inFence = true;
        fence = marker;
      } else if (marker === fence && trimmed.replace(/`|~/g, "").length === 0) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (m) {
      const text = m[2].replace(/\s+#+\s*$/, "").trim();
      const base = slugifyHeading(text);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const slug = n === 0 ? base : `${base}-${n}`;
      out.push({ level: m[1].length, text, slug, pos: lineStart });
    }
  }
  return out;
}

/** 제목들에서 마크다운 목차를 만든다 — 들여쓰기는 단계별 2칸, 앵커는
 *  collectHeadings의 GitHub식 슬러그(중복 -1 접미 포함). 프론트매터는
 *  미리 뗀 텍스트를 넘길 것(호출자 책임). 순수 함수. */
export function tocMarkdown(headings: Heading[]): string {
  if (headings.length === 0) return "";
  // 최상위 단계를 목록 뿌리로(문서가 h2부터 시작하면 h2가 루트).
  const root = Math.min(...headings.map((h) => h.level));
  const lines = headings.map((h) => {
    const indent = "  ".repeat(Math.max(0, h.level - root));
    return `${indent}- [${h.text}](#${h.slug})`;
  });
  return lines.join("\n");
}
