// mermaid 지연 로딩 + SVG 렌더. 문서에 다이어그램이 있을 때만 청크를 내려받는다.
// securityLevel:'strict'로 HTML 주입을 차단하고(§4-6), htmlLabels:false로
// foreignObject 없는 순수 SVG를 만든다(DOCX 변환 전제, §4-3).

type Mermaid = (typeof import("mermaid"))["default"];

let mod: Mermaid | null = null;
let loading: Promise<Mermaid> | null = null;
let currentTheme: "light" | "dark" | null = null;
let seq = 0;

export async function ensureMermaid(theme: "light" | "dark"): Promise<Mermaid> {
  const themeChanged = currentTheme !== theme;
  if (!mod) {
    mod = await (loading ??= (async () => (await import("mermaid")).default)());
    mod.initialize(defaultsFor(theme));
    currentTheme = theme;
    return mod;
  }
  if (themeChanged) {
    currentTheme = theme;
    mod.initialize(defaultsFor(theme));
  }
  return mod;
}

function defaultsFor(theme: "light" | "dark") {
  return {
    startOnLoad: false,
    securityLevel: "strict" as const,
    theme: (theme === "dark" ? "dark" : "default") as "dark" | "default",
    fontFamily:
      '-apple-system, "SF Pro Text", "Apple SD Gothic Neo", "Helvetica Neue", sans-serif',
    flowchart: { htmlLabels: false },
    gantt: { useWidth: 800 },
  };
}

const cache = new Map<string, string>();

// 렌더 큐 — mermaid.render는 CPU를 많이 쓰는 긴 작업이라 동시에 몰리면
// 프레임이 통째로 걸린다. 한 번에 하나만 직렬 실행해 긴 작업이 겹치지 않게
// 한다(스크롤로 다이어그램 여러 개가 동시에 보여도 순차 그려진다).
const renderQueue: Array<() => void> = [];
let renderActive = 0;

function enqueueRender<T>(job: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    renderQueue.push(() => {
      renderActive++;
      job().then(resolve, reject).finally(() => {
        renderActive--;
        const next = renderQueue.shift();
        if (next) next();
      });
    });
    if (renderActive === 0 && renderQueue.length === 1) renderQueue[0]();
  });
}

/** mermaid 코드 → SVG 문자열(인라인 마운트용). 실패 시 null. */
export async function renderMermaid(
  code: string,
  theme: "light" | "dark",
): Promise<{ svg: string | null; error: string | null }> {
  const key = `${theme}:${code}`;
  const hit = cache.get(key);
  if (hit) return { svg: hit, error: null };
  const mermaid = await ensureMermaid(theme);
  const id = `iyagi-mermaid-${seq++}`;
  try {
    const { svg } = await enqueueRender(() => mermaid.render(id, code));
    cache.set(key, svg);
    return { svg, error: null };
  } catch (e) {
    return { svg: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** DOCX 내보내기용 — 원문 코드 → SVG(지금 테마와 무관하게 default 테마). */
export async function renderMermaidForExport(code: string): Promise<string | null> {
  const r = await renderMermaid(code, "light");
  return r.svg;
}
