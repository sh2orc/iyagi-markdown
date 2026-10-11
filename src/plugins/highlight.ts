// highlight.js 지연 로딩 — 내보내기 HTML의 코드 하이라이트용.
// (에디터 안의 코드 색은 CodeMirror 중첩 파서가 맡으므로 여기는 내보내기 전용.)

type Hljs = typeof import("highlight.js/lib/common")["default"];

let mod: Hljs | null = null;

export async function ensureHighlight(): Promise<Hljs> {
  mod ??= (await import("highlight.js/lib/common")).default;
  return mod;
}

export function highlightHtml(
  hljs: Hljs,
  code: string,
  lang: string | null,
): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      const r = hljs.highlight(code, { language: lang, ignoreIllegals: true });
      return r.value;
    } catch {
      // 아래 폴백으로
    }
  }
  return escapeHtml(code);
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
