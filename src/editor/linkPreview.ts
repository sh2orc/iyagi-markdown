// 위키링크 호버 미리보기(Obsidian page preview v1) — 대상 문서의 제목·첫 문단을
// 팝오버로. 마크다운 마커는 가벼운 정리만(v2: 렌더 미리보기 — 마크다운-it은
// 내보내기 청크에 있어 메인으로 못 당긴다, 15차 원칙). 순수 함수+DOM 관리 분리.

import { stripFrontMatter } from "./frontmatter";

/** 미리보기 텍스트 — 마커 정리·길이 제한. 순수 함수(테스트 대상). */
export function previewTextOf(markdown: string, maxChars = 400): { title: string; body: string } {
  const body0 = stripFrontMatter(markdown).trim();
  if (!body0) return { title: "", body: "" };
  const lines = body0.split("\n");
  // 제목: 첫 # 헤딩(없으면 첫 줄 텍스트).
  let title = "";
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (/^#{1,6}\s+/.test(t)) {
      title = t.replace(/^#{1,6}\s+/, "");
      start = i + 1;
    }
    break;
  }
  if (!title) {
    title = cleanMarkers(lines.find((l) => l.trim()) ?? "").slice(0, 80);
    start = lines.findIndex((l) => l.trim()) + 1;
  }
  // 본문: 제목 뒤 첫 비빈 줄들.
  const bodyLines: string[] = [];
  let count = 0;
  for (let i = start; i < lines.length && count < maxChars; i++) {
    const t = lines[i].trim();
    if (!t) {
      if (bodyLines.length > 0) break; // 첫 문단 끝
      continue;
    }
    if (/^#{1,6}\s+/.test(t)) break; // 다음 제목 전까지
    const c = cleanMarkers(t);
    bodyLines.push(c);
    count += c.length;
  }
  let body = bodyLines.join(" ");
  if (body.length > maxChars) body = `${body.slice(0, maxChars - 1)}…`;
  return { title, body };
}


/** 각주 정의 찾기 — [^라벨]: 정의(4칸 들여쓰기 연속 줄 포함). 순수 함수. */
export function footnoteDefinition(text: string, label: string, maxChars = 300): string {
  if (!label) return "";
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^\\[\\^${esc}\\]:\\s*(.+)$`, "m").exec(text);
  if (!m) return "";
  const lines = [m[1]];
  const after = text.slice(m.index + m[0].length).split("\n").slice(1);
  for (const l of after) {
    if (/^ {4,}\S/.test(l)) lines.push(l.trim());
    else break;
  }
  let out = cleanMarkers(lines.join(" "));
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1)}…`;
  return out;
}

/** TTS 입력 정화 — 프론트매터·펜스 제외 후 마커 정리(코드 낭독은 소음).
 *  순수 함수(테스트 대상). */
export function ttsTextOf(markdown: string): string {
  const body = stripFrontMatter(markdown);
  const noFence = body.replace(/(```|~~~)[^]*?\1/g, "");
  return noFence
    .split("\n")
    .map((l) => {
      // 표 줄은 파이프 낭독 대신 셀 나열로("a, b, c"). 구분 행은 건너뛴다.
      const t = l.trim();
      if (t.startsWith("|") && t.endsWith("|")) {
        const cells = t.slice(1, -1).split("|").map((c) => cleanMarkers(c.trim()));
        if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) return "";
        return cells.filter(Boolean).join(", ");
      }
      return cleanMarkers(l.replace(/^\s*#{1,6}\s+/, ""));
    })
    .filter((l) => l.trim().length > 0)
    .join("\n");
}

/** 표시용 마커 정리 — 굵게/기울임/코드/링크/이미지/각주/위키. */
export function cleanMarkers(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 이미지 → 대체텍스트
    .replace(/\[\^([^\]]+)\]/g, "") // 각주 참조 제거
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, name, disp) => disp || name) // 위키
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 링크 → 텍스트
    .replace(/(\*\*|__|\*|_|~~|`|=)/g, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// — v2: 렌더 미리보기(마크다운-it 지연 공유 — cm의 서식 복사와 같은 청크) —

let mdIt: import("markdown-it").MarkdownIt | null = null;
let mdItPromise: Promise<void> | null = null;

function ensureRenderer(): Promise<void> {
  mdItPromise ??= import("markdown-it").then((MarkdownIt) => {
    const md = new MarkdownIt.default({ html: false, linkify: true, breaks: false });
    // 이미지는 팝오버에서 무겁다 — 대체 텍스트로.
    md.renderer.rules.image = (tokens, idx) => tokens[idx].children?.[0]?.content ?? "";
    mdIt = md;
  });
  return mdItPromise;
}

/** 렌더 입력 — 문단 경계에서 잘라 렌더 비용 상한. 순수 함수. */
export function previewRenderInput(markdown: string, maxChars = 4000): string {
  const body = stripFrontMatter(markdown).trim();
  if (body.length <= maxChars) return body;
  const cut = body.slice(0, maxChars);
  const at = cut.lastIndexOf("\n\n");
  return (at > maxChars / 2 ? cut.slice(0, at) : cut) + "\n\n…";
}

/** 렌더된 미리보기 HTML(html:false 렌더러 — 원시 HTML 차단로 안전). */
export async function previewHtmlOf(markdown: string): Promise<string | null> {
  try {
    await ensureRenderer();
    return mdIt ? mdIt.render(previewRenderInput(markdown)) : null;
  } catch {
    return null;
  }
}

// — 캐시(재호버 즉시) —

const previewCache = new Map<string, PreviewEntry>();
const PREVIEW_CACHE_MAX = 30;

export interface PreviewEntry {
  title: string;
  body: string;
  /** v2 렌드 HTML(실패 시 null — 텍스트 폴백). */
  html: string | null;
}

/** 캐시 조회(LRU 갱신). 없으면 null. */
export function cachedLinkPreview(path: string): PreviewEntry | null {
  const hit = previewCache.get(path);
  if (hit) {
    previewCache.delete(path);
    previewCache.set(path, hit);
  }
  return hit ?? null;
}

export function rememberLinkPreview(path: string, p: PreviewEntry): void {
  previewCache.set(path, p);
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.delete(oldest);
  }
}

/** 무효화 — fs 이벤트(변경·삭제)에서 path별/전체. */
export function invalidateLinkPreviews(path?: string): void {
  if (path === undefined) previewCache.clear();
  else previewCache.delete(path);
}

/** 팝오버 — 하나만 유지, 마우스 근처에. */
let popover: HTMLDivElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

export function showLinkPreview(x: number, y: number, title: string, body: string, html?: string | null): void {
  hideLinkPreview();
  if (!title && !body && !html) return;
  popover = document.createElement("div");
  popover.className = "link-preview";
  if (html) {
    // html:false 렌더러 출력 — 원시 HTML이 차단된 안전한 마크다운 렌더 결과.
    const rich = document.createElement("div");
    rich.className = "link-preview-rich";
    rich.innerHTML = html;
    popover.append(rich);
  } else {
    if (title) {
      const h = document.createElement("div");
      h.className = "link-preview-title";
      h.textContent = title;
      popover.append(h);
    }
    if (body) {
      const b = document.createElement("div");
      b.className = "link-preview-body";
      b.textContent = body;
      popover.append(b);
    }
  }
  document.body.append(popover);
  const r = popover.getBoundingClientRect();
  const left = Math.min(x + 14, window.innerWidth - r.width - 12);
  const top = Math.min(y + 18, window.innerHeight - r.height - 12);
  popover.style.left = `${Math.max(12, left)}px`;
  popover.style.top = `${Math.max(12, top)}px`;
}

export function hideLinkPreview(): void {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  popover?.remove();
  popover = null;
}

/** 호버 팝오버 숨김 예약(즉시 아님 — 팝오버로 마우스 옮기는 사이 유지). */
export function scheduleHideLinkPreview(ms = 250): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(hideLinkPreview, ms);
}
