// KaTeX 지연 로딩. 문서에 수식이 있을 때만 청크(CSS+폰트)를 내려받는다(§1-2).
import { phrases } from "../app/phrases";

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

/** 위젯 DOM에 렌더 — 캐시 히트는 즉시, 첫 렌더는 프레임 예산 큐로 나눠 그린다.
 *  수식이 몰린 문서를 스크롤할 때 toDOM 안의 동기 KaTeX 렌더가 프레임을
 *  통째로 뺏지 않게 한다(한 프레임 ≤ MATH_FRAME_BUDGET_MS). onFill은 높이가
 *  변하는 비동기 채움 뒤에 불린다(재측정 트리거용). */
export function renderMathInto(
  el: HTMLElement,
  latex: string,
  display: boolean,
  onFill?: () => void,
): void {
  const hit = mod ? cache.get(`${display ? "D" : "I"}:${latex}`) : undefined;
  if (hit) {
    applyResult(el, latex, hit, display);
    return;
  }
  el.classList.add("md-math-pending");
  queueMath(() => {
    void ensureKatex().then(() => {
      const res = renderMathSync(latex, display);
      el.classList.remove("md-math-pending");
      if (res) {
        applyResult(el, latex, res, display);
        onFill?.();
      }
    });
  });
}

const MATH_FRAME_BUDGET_MS = 5;
const mathQueue: Array<() => void> = [];
let mathPumpRunning = false;

function pumpMathQueue(): void {
  const start = performance.now();
  while (mathQueue.length > 0 && performance.now() - start < MATH_FRAME_BUDGET_MS) {
    mathQueue.shift()!();
  }
  if (mathQueue.length > 0) scheduleMathPump();
  else mathPumpRunning = false;
}

function scheduleMathPump(): void {
  mathPumpRunning = true;
  // rAF가 없는 환경(테스트 일부)은 타이머로.
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(pumpMathQueue);
  else setTimeout(pumpMathQueue, 16);
}

function queueMath(job: () => void): void {
  mathQueue.push(job);
  if (!mathPumpRunning) scheduleMathPump();
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
    msg.textContent = `${phrases.mathError}: ${res.error}`;
    el.append(msg);
    return;
  }
  el.innerHTML = res.html;
  if (display) el.classList.add("md-math-display");
}
