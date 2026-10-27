// 링크·경로 해석 — crates/md-core/src/links.rs와 같은 규칙.
// 양쪽이 일치하는지는 코퍼스 테스트(links.test.ts ↔ Rust 테스트)로 검증한다.
// Tauri 의존 없이 순수하게 유지한다(단위 테스트·내보내기 공용).
import { GFM, parser } from "@lezer/markdown";
import { frontMatterLen } from "./editor/frontmatter";
import { mathSyntax } from "./editor/mathSyntax";

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
    // Match Rust's byte decoder, including malformed UTF-8 replacement characters.
    // Invalid percent escapes remain literal; an incomplete encoded sequence cannot
    // throw through editor rendering, link navigation, or image previews.
    const bytes = new TextEncoder().encode(s);
    const out = new Uint8Array(bytes.length);
    const hex = (b: number) => b >= 48 && b <= 57 ? b - 48
      : b >= 65 && b <= 70 ? b - 55 : b >= 97 && b <= 102 ? b - 87 : -1;
    let used = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 37 && i + 2 < bytes.length) {
        const high = hex(bytes[i + 1]), low = hex(bytes[i + 2]);
        if (high >= 0 && low >= 0) { out[used++] = high * 16 + low; i += 2; continue; }
      }
      out[used++] = bytes[i];
    }
    // Preserve an encoded BOM inside a URL, as String::from_utf8_lossy does.
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(out.subarray(0, used));
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

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
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

/** Reserve every emitted ID, including suffixes that another title can produce. */
export function createHeadingSlugger(): (text: string) => string {
  const next = new Map<string, number>();
  const used = new Set<string>();
  return (text) => {
    const base = slugifyHeading(text);
    let n = next.get(base) ?? 0;
    let candidate = n === 0 ? base : `${base}-${n}`;
    while (used.has(candidate)) candidate = `${base}-${++n}`;
    next.set(base, n + 1);
    used.add(candidate);
    return candidate;
  };
}

/** 문서의 모든 제목에 슬러그를 붙인다. 중복은 GitHub처럼 `-1` 접미로 구분. */
export interface Heading {
  level: number;
  text: string;
  slug: string;
  /** 제목 줄의 첫 글자 위치(문서 오프셋) — TOC 클릭 스크롤용. */
  pos: number;
  /** Container headings can be navigated to, but cannot be moved as root sections. */
  movable?: boolean;
}

const headingParser = parser.configure([GFM, mathSyntax]);

/** 내보내기용 setext 정규화 — 밑줄형 제목 짝(text\n--- · text\n===)에 빈
 *  줄을 넣어 문단+수평선으로 만든다. 에디터 방침(2026-10-21 '제목은 #/##
 *  로만')을 comrak(CommonMark) 내보내기까지 일관되게 — 타이핑 가드가 못
 *  미치는 붙여넣기·오래된 문서 경로를 흡수한다. 인용구 짝은 인용구를
 *  유지하는 빈 인용 줄(>)을 넣는다. 코드 블록 속 ---/=== 는 트리가 이미
 *  제외하므로 오탐 없다. 입력은 프런트매터를 뺀 본문. 순수 함수(테스트 대상).
 *  insertLines: 원본 본문 기준, 빈 줄이 새로 들어간 직전의 밑줄 줄 번호들
 *  (1-based) — 내보내기 코멘트 줄번호 보정에 쓴다. */
export function normalizeUnderlineRules(text: string): { text: string; insertLines: number[] } {
  const inserts: Array<{ pos: number; insert: string; line: number }> = [];
  headingParser.parse(text).iterate({
    enter(ref) {
      if (!/^SetextHeading[12]$/.test(ref.name)) return;
      const marks = ref.node.getChildren("HeaderMark");
      const mark = marks[marks.length - 1];
      if (!mark) return false;
      const lineStart = text.lastIndexOf("\n", mark.from - 1) + 1;
      const qm = /^(?:>[ \t]?)+/.exec(text.slice(lineStart, mark.from));
      const blank = qm ? qm[0].replace(/[ \t]+$/, "") + "\n" : "\n";
      inserts.push({
        pos: lineStart,
        insert: blank,
        line: text.slice(0, lineStart).split("\n").length,
      });
      return false;
    },
  });
  let out = text;
  for (let i = inserts.length - 1; i >= 0; i--) {
    const ins = inserts[i];
    out = out.slice(0, ins.pos) + ins.insert + out.slice(ins.pos);
  }
  return { text: out, insertLines: inserts.map((i) => i.line) };
}

/** Parse real ATX/Setext headings while preserving original UTF-16 offsets. */
export function collectHeadings(text: string): Heading[] {
  const slugFor = createHeadingSlugger();
  const out: Heading[] = [];
  const offset = frontMatterLen(text);
  const body = text.slice(offset);
  headingParser.parse(body).iterate({
    enter(ref) {
      const match = /^(ATX|Setext)Heading([1-6])$/.exec(ref.name);
      if (!match) return;
      const marks = ref.node.getChildren("HeaderMark");
      if (!marks.length) return false;
      const atx = match[1] === "ATX";
      // 밑줄형 setext(text\n--- · text\n===)는 이 앱의 제목이 아니다
      // (2026-10-21 방침 — 제목은 #/## 로만. 렌더가 제목이 아니므로 TOC에도
      // 올리지 않는다).
      if (!atx && /^[-=]+$/.test(body.slice(marks[0].from, marks[0].to))) return false;
      const from = atx ? marks[0].to : ref.from;
      const to = atx ? (marks[1]?.from ?? ref.to) : body.lastIndexOf("\n", marks[0].from - 1);
      const quotes: Array<{ from: number; to: number }> = [];
      const pending = [ref.node];
      while (pending.length) {
        const node = pending.pop()!;
        if (node.name === "QuoteMark" && node.from >= from && node.to <= to) quotes.push(node);
        for (let child = node.firstChild; child; child = child.nextSibling) pending.push(child);
      }
      let raw = "", at = from;
      for (const quote of quotes.sort((a, b) => a.from - b.from)) {
        raw += body.slice(at, quote.from);
        at = quote.to;
      }
      raw += body.slice(at, to);
      const title = raw.split(/\r?\n/).map((line) => line.trim()).join("\n").trim();
      const slug = slugFor(title);
      const absolute = offset + ref.from;
      out.push({ level: Number(match[2]), text: title, slug,
        pos: text.lastIndexOf("\n", absolute - 1) + 1,
        movable: ref.node.parent?.name === "Document" });
      return false;
    },
  });
  return out;
}

/** Build valid one-line TOC links, including multiline Setext titles. */
export function tocMarkdown(headings: Heading[]): string {
  if (headings.length === 0) return "";
  // 최상위 단계를 목록 뿌리로(문서가 h2부터 시작하면 h2가 루트).
  const root = Math.min(...headings.map((h) => h.level));
  const lines = headings.map((h) => {
    const indent = "  ".repeat(Math.max(0, h.level - root));
    const label = h.text.replace(/\s*\n\s*/g, " ").replace(/[\\[\]<>]/g, "\\$&");
    return `${indent}- [${label}](#${h.slug})`;
  });
  return lines.join("\n");
}
