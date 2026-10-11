// KaTeX 지연 로딩. 문서에 수식이 있을 때만 청크(CSS+폰트)를 내려받는다(§1-2).

type Katex = typeof import("katex");

let mod: Katex | null = null;
let loading: Promise<Katex> | null = null;

export function katexLoading(): boolean {
  return mod !== null;
}

export async function ensureKatex(): Promise<Katex> {
  mod ??= await (loading ??= (async () => {
    const [katex] = await Promise.all([
      import("katex"),
      // CSS 동적 import — vite가 폰트를 포함한 별도 청크로 분리한다.
      import("katex/dist/katex.min.css"),
    ]);
    return katex;
  })());
  return mod;
}

export interface MathRenderResult {
  html: string;
  error: string | null;
}

const cache = new Map<string, MathRenderResult>();
const CACHE_MAX = 500;

function remember(latex: string, res: MathRenderResult) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(latex, res);
}

/** LaTeX → KaTeX HTML. throwOnError:false — 오류는 원문과 함께 표시한다. */
export function renderMathSync(latex: string, display: boolean): MathRenderResult | null {
  if (!mod) return null;
  const key = `${display ? "D" : "I"}:${latex}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const html = mod.renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: false,
      output: "html",
    });
    const res = { html, error: null };
    remember(key, res);
    return res;
  } catch (e) {
    const res = { html: "", error: e instanceof Error ? e.message : String(e) };
    remember(key, res);
    return res;
  }
}

/** MathML 출력(DOCX 내보내기 manifest용). */
export async function renderMathMl(latex: string): Promise<string | null> {
  const katex = await ensureKatex();
  try {
    return katex.renderToString(latex, {
      displayMode: true,
      throwOnError: true,
      trust: false,
      output: "mathml",
    });
  } catch {
    return null;
  }
}

/** 위젯 DOM에 렌더 — 준비 안 됐으면 비동기로 채운다. */
export function renderMathInto(
  el: HTMLElement,
  latex: string,
  display: boolean,
): void {
  const sync = renderMathSync(latex, display);
  if (sync) {
    applyResult(el, latex, sync, display);
    return;
  }
  el.classList.add("md-math-pending");
  void ensureKatex().then(() => {
    const res = renderMathSync(latex, display);
    if (res) applyResult(el, latex, res, display);
    el.classList.remove("md-math-pending");
  });
}

function applyResult(
  el: HTMLElement,
  latex: string,
  res: MathRenderResult,
  display: boolean,
): void {
  if (res.error) {
    el.classList.add("md-math-error");
    const pre = document.createElement("code");
    pre.textContent = latex;
    el.append(pre);
    const msg = document.createElement("span");
    msg.className = "md-math-error-msg";
    msg.textContent = res.error;
    el.append(msg);
    return;
  }
  el.innerHTML = res.html;
  if (display) el.classList.add("md-math-display");
}
