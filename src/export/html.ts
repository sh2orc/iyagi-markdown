// 내보내기 전용 렌더러(§4-4): 마크다운 → 자체 완결형 단일 HTML.
// - 수식: KaTeX(HTML+CSS 인라인) — mermaid: 본문에 인라인 <svg>(img/base64 아님, §4-3).
// - 코드: highlight.js. 표·작업 목록: GFM.
// - 이미지: 로컬은 data URI로 인라인, 원격은 URL 유지.
// - CSS·KaTeX 폰트까지 전부 문서 안에 넣는다(스크립트는 포함하지 않는다).
//
// 편집 화면(CM6 위젯)과는 별개 파이프라인이다 — 모양 차이는 공통 CSS 토큰으로 관리(§4-4).

import MarkdownIt, { type MarkdownIt as MarkdownItType, type StateInline, type Token } from "markdown-it";
import { htmlTableKey } from "../editor/tableKey";
import footnote from "markdown-it-footnote";

import { ensureHighlight, escapeHtml, highlightHtml } from "../plugins/highlight";
import { ensureKatex, renderMathMl } from "../plugins/katex";
import { renderMermaidForExport } from "../plugins/mermaid";
import { stripFrontMatter } from "../editor/frontmatter";
import { wikiLinksToMarkdown } from "../editor/wiki";

export interface ExportHtmlOptions {
  title: string;
  baseDir: string;
  theme: "light" | "dark";
  /** 문서별 스타일(라이브 프리뷰와 동일 반영 — 폰트·크기·행간·들여쓰기·정렬·강조색). */
  style?: {
    font: "system" | "serif" | "round" | "mono";
    sizePt: number;
    lineHeight: number;
    firstLineIndent: boolean;
    textAlign: "left" | "center" | "right" | "justify";
    accent: string | null;
  };
  /** PDF용: 본문 여백(mm)과 배율을 CSS에 반영한다. */
  forPdf?: boolean;
  marginMm?: number;
  scale?: number;
  /** PDF 하단 페이지 번호(N / M — WebKit 인쇄에서 매 페이지 반복). */
  pageNumbers?: boolean;
  /** PDF 머리글(문서 제목, 매 페이지 상단 — Word 실행 머리글). 값이 있으면 켬. */
  pdfHeader?: string | null;
  /** 사이드카 이미지 폭(%) — 마크다운 src 키. 인라인化 전 <img>에 style로. */
  imageWidths?: Record<string, number>;
  /** 사이드카 표 열 폭(px) — 헤더 내용 키. <colgroup> 비율로. */
  tableWidths?: Record<string, number[]>;
  /** 로컬 이미지를 data URI로 인라인할지(HTML 내보내기 기본 켬). */
  inlineImages?: boolean;
  /** 이미지 바이너리 읽기(앱: Tauri 명령). 없으면 인라인 생략. */
  readBytes?: (path: string) => Promise<Uint8Array | null>;
  /** 위키링크 이름 → 절대 경로(워크스페이스 인덱스). 없으면 이름.md 참조. */
  wikiResolve?: (name: string) => string | null;
}

// — 마크다운 파서 구성 —

function makeMd(): MarkdownItType {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: false, typographer: false });
  md.use(footnote);
  // $…$ · $$…$$ 수식 규칙(§4-4: KaTeX로 렌더).
  // ==하이라이트== → <mark>(Obsidian 호환).
  md.inline.ruler.before("escape", "iyagi_highlight", (state: StateInline, silent: boolean) => {
    const src = state.src;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x3d || src.charCodeAt(pos + 1) !== 0x3d) return false;
    const after = src.charCodeAt(pos + 2);
    if (after === 0x20 || after === 0x0a || after === 0x3d || Number.isNaN(after)) return false;
    const close = src.indexOf("==", pos + 2);
    if (close === -1 || src[close - 1] === "\\") return false;
    if (!silent) {
      const token = state.push("iyagi_highlight", "", 0);
      token.content = src.slice(pos + 2, close);
    }
    state.pos = close + 2;
    return true;
  });
  md.renderer.rules.iyagi_highlight = (tokens, idx) =>
    `<mark class="hl">${escapeHtml(tokens[idx].content)}</mark>`;
  md.inline.ruler.before("escape", "iyagi_math", (state: StateInline, silent: boolean) => {
    const src = state.src;
    const pos = state.pos;
    if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
    const display = src.charCodeAt(pos + 1) === 0x24;
    const open = display ? "$$" : "$";
    if (display) {
      const after = src.charCodeAt(pos + 2);
      if (after === 0x20 || after === 0x0a) return false;
    } else {
      const after = src.charCodeAt(pos + 1);
      if (after === 0x20 || after === 0x0a || after === 0x24) return false;
    }
    const close = src.indexOf(open, pos + open.length);
    if (close === -1) return false;
    if (!display && src.charCodeAt(close - 1) === 0x5c /* \ */) return false;
    const latex = src.slice(pos + open.length, close);
    if (!display && /^\d/.test(src.slice(close + open.length))) return false; // $5
    if (!silent) {
      const token = state.push("iyagi_math", "", 0);
      token.content = latex;
      token.meta = { display };
    }
    state.pos = close + open.length;
    return true;
  });
  return md;
}

interface FenceInfo {
  lang: string;
  code: string;
}

/** 마크다운 → HTML 본문 + 수식/다이어그램 정보. 비동기(렌더 완료를 기다린다). */
export async function renderMarkdownBody(
  markdown: string,
  opts: ExportHtmlOptions,
): Promise<{ body: string; mathMap: Map<string, string> }> {
  const md = makeMd();
  const [katex] = await Promise.all([ensureKatex(), ensureHighlight()]);

  // mermaid 펜스는 자리표시자로 바꾸고 코드를 따로 모은 뒤 나중에 SVG로 치환한다.
  const diagrams: FenceInfo[] = [];
  const hljs = await ensureHighlight();
  md.renderer.rules.fence = (tokens: Token[], idx: number) => {
    const token = tokens[idx];
    const info = (token.info || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
    if (info === "mermaid") {
      const i = diagrams.length;
      diagrams.push({ lang: "mermaid", code: token.content });
      return `<div class="mermaid-block" data-mermaid="${i}"></div>`;
    }
    return `<pre class="code-block"><code class="language-${escapeHtml(info)}">${highlightHtml(
      hljs,
      token.content,
      info || null,
    )}</code></pre>`;
  };

  const mathMap = new Map<string, string>();
  md.renderer.rules.iyagi_math = (tokens, idx) => {
    const token = tokens[idx];
    const display = !!(token.meta as { display?: boolean } | null)?.display;
    const latex = token.content;
    try {
      return katex.renderToString(latex, {
        displayMode: display,
        throwOnError: true,
        trust: false,
        output: "html",
      });
    } catch {
      return `<code class="math-fallback">${escapeHtml(latex)}</code>`;
    }
  };

  // 문서 렌더 1차.
  let html = md.render(markdown);

  // mermaid SVG 치환(인라인 <svg> — 래스터화 없음, §4-3).
  const blocks = [...html.matchAll(/<div class="mermaid-block" data-mermaid="(\d+)"><\/div>/g)];
  const rendered = await Promise.all(
    blocks.map(async (m) => {
      const i = Number(m[1]);
      const svg = diagrams[i] ? await renderMermaidForExport(diagrams[i].code) : null;
      return { m, svg };
    }),
  );
  for (const { m, svg } of rendered) {
    html = html.replace(
      m[0],
      svg ? `<div class="diagram">${cleanMermaidSvg(svg)}</div>` : `<pre class="code-block"><code>${escapeHtml(diagrams[Number(m[1])]?.code ?? "")}</code></pre>`,
    );
  }

  // 작업 목록 체크박스 — 최종 HTML에서 [ ] / [x]를 input으로 바꾼다.
  html = html.replace(
    /(<li>)(<p>)?\[([ xX])\] /g,
    (_m, li: string, p: string | undefined, mark: string) =>
      `${li}${p ?? ""}<input class="task-item" type="checkbox" disabled${mark !== " " ? " checked" : ""}> `,
  );

  // MathML 지도(DOCX 매니페스트용은 별도 함수에서 수집 — 여기선 HTML 전용).
  void mathMap;
  void opts;
  return { body: html, mathMap };
}

function cleanMermaidSvg(svg: string): string {
  // max-width 고정 스타일을 풀어 반응형으로.
  return svg.replace(/max-width:\s*[\d.]+px;?/g, "").replace(/width="100%"/g, "");
}

// — 이미지 인라인 —


/** PDF 페이지 장식(머리글·바닥글) 조각 — 순수 함수. WebKit createPDF는
 *  fixed 요소를 한 번만 렌더하므로, JS가 컬럼마다 absolute 요소를 심는다.
 *  제목은 JSON 리터럴로 넣고 </script>만 이스케이프(태그 탈출 방지). */
export function pdfPageChrome(
  pageNumbers: boolean,
  headerTitle: string | null,
): { css: string; body: string; script: string } {
  const showNum = pageNumbers;
  const showHead = !!headerTitle;
  if (!showNum && !showHead) return { css: "", body: "", script: "" };
  const css = `.pdf-pagenum {
        position: fixed;
        bottom: 8mm;
        left: 0;
        right: 0;
        text-align: center;
        font-size: 9px;
        color: #888;
        font-family: -apple-system, sans-serif;
      }
      .pdf-pagenum-data, .pdf-head-data { position: absolute; top: 0; left: 0; right: 0; }`;
  const body = `${showNum ? `<div class="pdf-pagenum" aria-hidden="true"></div>` : ""}${showHead ? `<div class="pdf-head" aria-hidden="true"></div>` : ""}`;
  const titleLit = showHead
    ? JSON.stringify(headerTitle).replace(/<\//g, "<\\/")
    : "null";
  const script = `(function() {
  var numHost = document.querySelector('.pdf-pagenum');
  var headHost = document.querySelector('.pdf-head');
  if (!numHost && !headHost) return;
  var wrap = document.querySelector('#iyagi-page-wrap');
  if (!wrap) return;
  var cs = getComputedStyle(wrap);
  var gap = parseFloat(cs.columnGap) || 0;
  var colW = parseFloat(cs.columnWidth) || 0;
  if (!colW) return;
  var total = Math.max(1, Math.ceil(wrap.scrollWidth / (colW + gap)));
  var suffix = ' / ' + total;
  if (numHost) numHost.remove();
  if (headHost) headHost.remove();
  wrap.style.position = 'relative';
  var padTop = parseFloat(cs.paddingTop) || 0;
  var headTop = Math.max(6, Math.round(padTop * 0.3));
  var TITLE = ${titleLit};
  for (var i = 1; i <= total; i++) {
    var left = ((i - 1) * (colW + gap)) + 'px';
    var width = colW + 'px';
    ${showNum ? `if (numHost) {
      var n = document.createElement('div');
      n.className = 'pdf-pagenum-data';
      n.style.left = left; n.style.width = width;
      n.style.top = (wrap.offsetHeight - 24) + 'px';
      n.style.textAlign = 'center'; n.style.fontSize = '9px'; n.style.color = '#888';
      n.textContent = i + suffix;
      wrap.appendChild(n);
    }` : ""}
    ${showHead ? `if (headHost) {
      var h = document.createElement('div');
      h.className = 'pdf-head-data';
      h.style.left = left; h.style.width = width;
      h.style.top = headTop + 'px';
      h.style.textAlign = 'center'; h.style.fontSize = '9px'; h.style.color = '#888';
      h.style.borderBottom = '.5px solid rgba(0,0,0,.14)';
      h.style.padding = '0 8mm 3px'; h.style.boxSizing = 'border-box';
      h.textContent = TITLE;
      wrap.appendChild(h);
    }` : ""}
  }
})();`;
  return { css, body, script };
}

/** 사이드카 표 열 폭(px)을 렌더된 <table>의 <colgroup> %(비율)로 반영.
 *  편집기에서 드래그한 비율이 페이지 폭에 맞아 재배치된다. */
export function applyTableWidths(
  html: string,
  widths: Record<string, number[]>,
): string {
  const keys = Object.keys(widths);
  if (keys.length === 0) return html;
  return html.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => {
    const cells = widths[htmlTableKey(table)];
    if (!cells || cells.length < 2) return table;
    const sum = cells.reduce((a, b) => a + b, 0);
    if (sum <= 0) return table;
    const cols = cells
      .map((w) => `<col style="width:${((w / sum) * 100).toFixed(2)}%">`)
      .join("");
    // 마크다운-it은 colgroup 없이 렌더한다 — 여기가 첫 삽입이다.
    return table.replace(/(<table\b[^>]*>)/, `$1<colgroup>${cols}</colgroup>`);
  });
}

/** 사이드카 이미지 폭(%)을 <img> style로 반영. 원본 src를 키로 쓰므로
 *  data URI 인라인化 전에 호출한다. 퍼센트 디코딩한 표기도 같이 매칭. */
export function applyImageWidths(html: string, widths: Record<string, number>): string {
  const keys = Object.keys(widths);
  if (keys.length === 0) return html;
  const norm = new Map<string, number>();
  for (const k of keys) {
    const pct = Math.min(100, Math.max(5, Math.round(widths[k] ?? 100)));
    norm.set(k, pct);
    try {
      norm.set(decodeURIComponent(k), pct);
    } catch {
      /* 원본 키만 */
    }
  }
  const pctOf = (src: string): number | undefined => {
    if (norm.has(src)) return norm.get(src);
    try {
      return norm.get(decodeURIComponent(src));
    } catch {
      return undefined;
    }
  };
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = / src="([^"]*)"/.exec(tag);
    if (!m) return tag;
    const pct = pctOf(m[1]);
    if (pct === undefined) return tag;
    const decl = `width:${pct}%;height:auto`;
    const style = / style="([^"]*)"/.exec(tag);
    if (style) {
      const cleaned = style[1].replace(/(?:^|;)\s*(?:width|height):[^;"]*/g, "").replace(/^;\s*/, "").trim();
      return tag.replace(style[0], `style="${cleaned ? `${cleaned};` : ""}${decl}"`);
    }
    return tag.replace(m[0], `${m[0]} style="${decl}"`);
  });
}

async function inlineImages(html: string, baseDir: string, readBytes?: (p: string) => Promise<Uint8Array | null>): Promise<string> {
  if (!readBytes) return html;
  const seen = new Map<string, string>();
  const jobs: Promise<void>[] = [];
  const re = /src="(https?:\/\/[^"]+|data:[^"]+)"/g;
  // 원격·데이터 URI는 그대로.
  html.match(re);
  const localRe = /src="([^"]+)"/g;
  const out = html.replace(localRe, (full, src: string) => {
    if (/^(https?:|data:|#|mailto:)/i.test(src)) return full;
    jobs.push(
      (async () => {
        try {
          const decoded = decodeURIComponent(src).replace(/\\/g, "/");
          const path = decoded.startsWith("/") ? decoded : joinPath(baseDir, decoded);
          const key = src;
          if (!seen.has(key)) {
            const bytes = await readBytes(path);
            if (bytes) {
              const mime = guessMime(path);
              let bin = "";
              const CH = 0x8000;
              for (let i = 0; i < bytes.length; i += CH) {
                bin += String.fromCharCode(...bytes.subarray(i, i + CH));
              }
              seen.set(key, `data:${mime};base64,${btoa(bin)}`);
            } else {
              seen.set(key, "");
            }
          }
        } catch {
          seen.set(src, "");
        }
      })(),
    );
    return full;
  });
  await Promise.all(jobs);
  // 치환(실패한 것은 원본 유지).
  return out.replace(localRe, (full, src: string) => {
    const data = seen.get(src);
    return data ? `src="${data}"` : full;
  });
}

function joinPath(base: string, rel: string): string {
  const parts = `${base}/${rel}`.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return "/" + out.join("/");
}

function guessMime(path: string): string {
  const ext = path.substring(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    case "ico": return "image/x-icon";
    case "svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

// — KaTeX CSS+폰트 인라인 —

let katexCssCache: string | null = null;

async function inlineKatexCss(): Promise<string> {
  if (katexCssCache) return katexCssCache;
  const cssUrl = (await import("katex/dist/katex.min.css?url")).default;
  let css: string;
  try {
    css = await (await fetch(cssUrl)).text();
  } catch {
    return "";
  }
  const urls = new Set<string>();
  for (const m of css.matchAll(/url\((['"]?)([^'")]+)\1\)/g)) urls.add(m[2]);
  for (const u of urls) {
    try {
      const abs = new URL(u, cssUrl).toString();
      const buf = await (await fetch(abs)).arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CH));
      }
      const ext = u.substring(u.lastIndexOf(".") + 1).toLowerCase();
      const mime = ext === "woff2" ? "font/woff2" : ext === "woff" ? "font/woff" : ext === "ttf" ? "font/ttf" : "application/octet-stream";
      css = css.split(`url(${u})`).join(`url(data:${mime};base64,${btoa(bin)})`);
    } catch {
      // 폰트 하나 실패는 치명적이지 않다.
    }
  }
  katexCssCache = css;
  return css;
}

// — 전체 문서 조립 —

export async function buildExportHtml(markdown: string, opts: ExportHtmlOptions): Promise<string> {
  // 프론트매터는 메타 — 인쇄·HTML 본문에서 제외한다(모든 호출 경로의 공통 끝점).
  // 위키링크는 표준 마크다운 링크로(resolve 미제공이면 이름.md 참조).
  const body0 = wikiLinksToMarkdown(
    stripFrontMatter(markdown),
    opts.wikiResolve ?? (() => null),
    opts.baseDir,
  );
  const [{ body }, katexCss] = await Promise.all([renderMarkdownBody(body0, opts), inlineKatexCss()]);
  // 사이드카 폭은 원본 src 키로 매칭 — data URI 인라인化 전에 적용한다.
  const withWidths = applyTableWidths(
    applyImageWidths(body, opts.imageWidths ?? {}),
    opts.tableWidths ?? {},
  );
  const withImages = opts.inlineImages === false
    ? withWidths
    : await inlineImages(withWidths, opts.baseDir, opts.readBytes);
  const sanitized = await sanitize(withImages);
  const marginCss = opts.forPdf
    ? `body{margin:${opts.marginMm ?? 14}mm !important;}` +
      `html{font-size:${(16 * (opts.scale ?? 1)).toFixed(1)}px;}`
    : "";
  // 페이지 장식(머리글·바닥글) — 고정 위치 요소가 WebKit createPDF에서 매
  // "페이지"(=컬럼)에 반복 나타나지는 않으므로 JS가 컬럼마다 absolute로 심는다.
  const chrome = opts.forPdf
    ? pdfPageChrome(!!opts.pageNumbers, opts.pdfHeader ?? null)
    : { css: "", body: "", script: "" };
  // 문서별 스타일 — 라이브 프리뷰의 문서 스타일 패널과 같은 값.
  const st = opts.style;
  const styleCss = st
    ? `body{` +
      (st.font === "serif"
        ? `font-family:"New York",ui-serif,Georgia,"Apple SD Gothic Neo","Nanum Myeongjo",serif;`
        : st.font === "round"
          ? `font-family:ui-rounded,-apple-system,"SF Pro Rounded","Apple SD Gothic Neo",sans-serif;`
          : st.font === "mono"
            ? `font-family:ui-monospace,"SF Mono",Menlo,monospace;`
            : "") +
      (st.sizePt > 0 ? `font-size:${st.sizePt}px;` : "") +
      (st.lineHeight > 0 ? `line-height:${st.lineHeight};` : "") +
      `}` +
      (st.firstLineIndent ? `.markdown-body p{text-indent:1.25em;}` : ``) +
      (st.textAlign && st.textAlign !== "left" ? `.markdown-body p{text-align:${st.textAlign};}` : ``) +
      (st.accent
        ? `.markdown-body a{color:${st.accent};}.markdown-body a:hover{text-decoration-color:${st.accent};}`
        : ``)
    : "";
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>
:root{color-scheme:${opts.theme};}
${themeCss(opts.theme)}
${styleCss}
${chrome.css}
${katexCss}
${marginCss}
</style>
</head>
<body>
${chrome.body}
${opts.forPdf ? "" : `<header class="doc-header"><h1>${escapeHtml(opts.title)}</h1></header>`}
<article class="markdown-body">
${sanitized}
</article>
${chrome.script ? `<script id="iyagi-pdf-chrome" type="text/plain">
${chrome.script}
</script>` : ""}
</body>
</html>`;
}

async function sanitize(html: string): Promise<string> {
  const purify = (await import("dompurify")).default;
  return purify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    ADD_ATTR: ["target", "rel", "checked", "disabled", "aria-hidden", "viewBox", "preserveAspectRatio"],
    ADD_TAGS: ["foreignobject"],
  });
}

function themeCss(theme: "light" | "dark"): string {
  const dark = theme === "dark";
  const c = dark
    ? {
        bg: "#1e1e21", fg: "#dcddde", heading: "#f2f3f5", link: "#8ab4f8",
        border: "#3c3d41", codeBg: "#2a2b2f", quote: "#9aa0a6", mark: "#6e7781",
        synK: "#c792ea", synS: "#a5d6a7", synC: "#7d8590", synN: "#f78c6c", synF: "#82aaff", synT: "#ffcb6b",
      }
    : {
        bg: "#ffffff", fg: "#24292f", heading: "#1f2328", link: "#0969da",
        border: "#d0d7de", codeBg: "#f6f8fa", quote: "#59636e", mark: "#8c959f",
        synK: "#cf222e", synS: "#0a3069", synC: "#6e7781", synN: "#0550ae", synF: "#8250df", synT: "#953800",
      };
  return `
html{-webkit-print-color-adjust:exact;}
body{margin:0 auto;padding:24px 16px;max-width:820px;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Apple SD Gothic Neo","Helvetica Neue",Arial,sans-serif;color:${c.fg};background:${c.bg};line-height:1.68;}
.doc-header{margin-bottom:8px;}
.doc-header h1{font-size:1em;font-weight:400;opacity:.55;margin:0;}
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body h5,.markdown-body h6{color:${c.heading};line-height:1.3;margin:1.4em 0 .5em;}
.markdown-body h1{font-size:1.9em;border-bottom:1px solid ${c.border};padding-bottom:.3em;}
.markdown-body h2{font-size:1.5em;border-bottom:1px solid ${c.border};padding-bottom:.25em;}
.markdown-body h3{font-size:1.25em;}
.markdown-body p{margin:.65em 0;}
.markdown-body a{color:${c.link};text-decoration:none;}
.markdown-body a:hover{text-decoration:underline;}
.markdown-body code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.9em;background:${c.codeBg};border-radius:4px;padding:.15em .35em;}
.markdown-body pre{background:${c.codeBg};border-radius:8px;padding:12px 14px;overflow-x:auto;line-height:1.5;}
.markdown-body pre code{background:none;padding:0;font-size:.88em;}
.markdown-body blockquote{margin:.8em 0;padding:.1em 14px;border-left:4px solid ${c.border};color:${c.quote};}
.markdown-body table{border-collapse:collapse;margin:1em 0;display:block;max-width:100%;overflow-x:auto;}
.markdown-body th,.markdown-body td{border:1px solid ${c.border};padding:6px 14px;}
.markdown-body th{background:${c.codeBg};font-weight:600;}
.markdown-body img{max-width:100%;border-radius:6px;}
.markdown-body hr{border:none;border-top:2px solid ${c.border};margin:1.6em 0;}
.markdown-body .task-item{margin-right:.45em;}
.markdown-body li.task-item-done{text-decoration:line-through;opacity:.6;}
.markdown-body .diagram{text-align:center;margin:1em 0;overflow-x:auto;}
.markdown-body .diagram svg{max-width:100%;height:auto;}
.markdown-body .math-fallback{color:#d33;}
.markdown-body .footnotes{margin-top:2.5em;border-top:1px solid ${c.border};font-size:.92em;color:${c.quote};}
.markdown-body .footnote-backref{text-decoration:none;}
.katex-display{margin:.85em 0;overflow-x:auto;overflow-y:hidden;}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in{color:${c.synK};}
.hljs-string,.hljs-attr{color:${c.synS};}
.hljs-comment,.hljs-quote{color:${c.synC};font-style:italic;}
.hljs-number,.hljs-literal{color:${c.synN};}
.hljs-function .hljs-title,.hljs-title.function_,.hljs-name{color:${c.synF};}
.hljs-type,.hljs-class .hljs-title,.hljs-title.class_{color:${c.synT};}
@media print{
  body{padding:0;}
  .markdown-body pre,.markdown-body table,.markdown-body .diagram,.katex-display{page-break-inside:avoid;}
  .markdown-body h1,.markdown-body h2,.markdown-body h3{page-break-after:avoid;}
}
`.trim();
}

/** DOCX 내보내기용 매니페스트(수식 MathML·다이어그램 SVG) — §4-4. */
export async function buildDocxManifest(
  markdown: string,
): Promise<{
  math: Record<string, string>;
  diagrams: Record<string, string>;
  style?: {
    font: "system" | "serif" | "round" | "mono";
    sizePt: number;
    lineHeight?: number;
    firstLineIndent?: boolean;
    textAlign?: "left" | "center" | "right" | "justify";
    accent?: string | null;
    pageNumbers?: boolean;
  };
  /** 사이드카 이미지 폭(%) — 마크다운 src 키 → 그림 extent 축소. */
  imageWidths?: Record<string, number>;
  /** 사이드카 표 열 폭(px) — 헤더 내용 키 → tblGrid 비율. */
  tableWidths?: Record<string, number[]>;
  /** 프런트매터 메타 — core.xml(dc:title·dc:creator). */
  title?: string;
  author?: string;
}> {
  const math: Record<string, string> = {};
  const diagrams: Record<string, string> = {};
  const jobs: Promise<void>[] = [];
  // 디스플레이 수식 $$...$$
  for (const m of markdown.matchAll(/\$\$([\s\S]+?)\$\$/g)) {
    const latex = m[1].trim();
    jobs.push(
      renderMathMl(latex).then((ml) => {
        if (ml) math[latex] = ml;
      }),
    );
  }
  // 인라인 $...$ (디스플레이와 겹치지 않게 단순 스캔)
  const stripped = markdown.replace(/\$\$[\s\S]+?\$\$/g, "").replace(/```[\s\S]*?```/g, "");
  for (const m of stripped.matchAll(/\$([^$\n]+?)\$/g)) {
    const latex = m[1].trim();
    if (!latex || /^\d/.test(latex)) continue;
    jobs.push(
      renderMathMl(latex).then((ml) => {
        if (ml) math[latex] = ml;
      }),
    );
  }
  // mermaid 펜스
  for (const m of markdown.matchAll(/```mermaid[^\n]*\n([\s\S]*?)```/g)) {
    const code = m[1].trimEnd();
    jobs.push(
      renderMermaidForExport(code).then((svg) => {
        if (svg) diagrams[code] = svg;
      }),
    );
  }
  await Promise.all(jobs);
  return { math, diagrams };
}
