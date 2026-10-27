// 내보내기 전용 렌더러(§4-4): 마크다운 → 자체 완결형 단일 HTML.
// - 수식: KaTeX(HTML+CSS 인라인) — mermaid: 본문에 인라인 <svg>(img/base64 아님, §4-3).
// - 코드: highlight.js. 표·작업 목록: GFM.
// - 이미지: 로컬은 data URI로 인라인, 원격은 URL 유지.
// - CSS·KaTeX 폰트까지 전부 문서 안에 넣는다(스크립트는 포함하지 않는다).
//
// 편집 화면(CM6 위젯)과는 별개 파이프라인이다 — 모양 차이는 공통 CSS 토큰으로 관리(§4-4).

import MarkdownIt, { type MarkdownIt as MarkdownItType, type StateInline, type Token } from "markdown-it";
import type { DocxManifest } from "../api";
import { htmlTableKey } from "../editor/tableKey";
import { createHeadingSlugger } from "../links";
import { captionWorthy } from "../editor/caption";
import { applyTableCaptions } from "../editor/tableCaption";
import footnote from "markdown-it-footnote";

import { ensureHighlight, escapeHtml, highlightHtml } from "../plugins/highlight";
import { ensureKatex, renderMathMl } from "../plugins/katex";
import { renderMermaidForExport } from "../plugins/mermaid";
import { frontMatterMeta, stripFrontMatter } from "../editor/frontmatter";
import { isPageBreakLine } from "../editor/pagebreak";
import { citeDisplay, citeNumbering } from "../editor/citations";
import { CALLOUT_ICONS, calloutKeyOf } from "../editor/widgets";
import { wikiLinksToMarkdown } from "../editor/wiki";

export interface ExportHtmlOptions {
  title: string;
  baseDir: string;
  theme: "light" | "dark";
  /** Small selection previews can show diagram source without mounting Mermaid. */
  renderDiagrams?: boolean;
  /** 문서별 스타일(라이브 프리뷰와 동일 반영 — 폰트·크기·행간·들여쓰기·정렬·강조색). */
  style?: {
    font: "system" | "serif" | "round" | "mono";
    sizePt: number;
    lineHeight: number;
    firstLineIndent: boolean;
    textAlign: "left" | "center" | "right" | "justify";
    accent: string | null;
    /** 형광펜 색(RRGGBB, null = 기본 노랑). */
    highlightColor?: string | null;
  };
  /** PDF용: 본문 여백(mm)과 배율을 CSS에 반영한다. */
  forPdf?: boolean;
  paper?: "a4" | "letter" | "a5";
  orientation?: "portrait" | "landscape";
  marginMm?: number;
  scale?: number;
  /** PDF 하단 페이지 번호(N / M — WebKit 인쇄에서 매 페이지 반복). */
  pageNumbers?: boolean;
  /** PDF 머리글(문서 제목, 매 페이지 상단 — Word 실행 머리글). 값이 있으면 켬. */
  pdfHeader?: string | null;
  /** PDF 바닥글 자유 텍스트(프런트매터 footer:) — 쪽번호와 함께. */
  pdfFooter?: string | null;
  /** 사이드카 이미지 폭(%) — 마크다운 src 키. 인라인化 전 <img>에 style로. */
  imageWidths?: Record<string, number>;
  /** 사이드카 표 열 폭(px) — 헤더 내용 키. <colgroup> 비율로. */
  tableWidths?: Record<string, number[]>;
  /** 문서 앞 목차·그림 목차·표 목차(DOCX lof/lot과 대칭 — 정적 링크 목록). */
  frontLists?: { toc: boolean; lof: boolean; lot: boolean };
  /** UI 언어 — 목차 라벨 현지화(기본 ko). */
  lang?: "ko" | "en";
  /** 미리 렌더한 본문(renderExportBody 결과) — 조립만 다시 할 때(인쇄
   *  미리보기 슬라이더). 없으면 내부에서 렌더한다. */
  preRendered?: string;
  /** 외부 링크를 새 탭으로(target=_blank + noopener). */
  externalLinksNewTab?: boolean;
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
  // `\newpage` 문단 → 페이지 나눔 div(인쇄·PDF에서 break-before). pandoc 규약.
  md.core.ruler.push("iyagi_pagebreak", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i + 2 < tokens.length; i++) {
      if (tokens[i].type !== "paragraph_open" || tokens[i].meta?.iyagiBibliography) continue;
      if (tokens[i + 1]?.type !== "inline" || tokens[i + 2]?.type !== "paragraph_close") continue;
      if (!isPageBreakLine(tokens[i + 1].content)) continue;
      const br = new state.Token("html_block", "", 0);
      br.content = '<div class="page-break"></div>';
      tokens.splice(i, 3, br);
    }
  });
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
  // 제목에 슬러그 id — 내부 앵커(#해시) 링크가 내보내기 HTML에서도 작동하게
  // 하고 정적 목차가 같은 id를 가리키게 한다. 규칙은 links.ts와 동일.
  const slugFor = createHeadingSlugger();
  md.renderer.rules.heading_open = (tokens, idx) => {
    const lvl = tokens[idx].tag;
    const text = tokens[idx + 1]?.content ?? "";
    const slug = slugFor(text);
    return `<${lvl} id="${slug}">`;
  };
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

function restoreLiteralCitations(tokens: Token[]): void {
  for (const token of tokens) {
    if (token.type === "iyagi_cite") {
      token.content = (token.meta as { raw: string }).raw;
      token.type = "text";
      token.meta = null;
    }
    if (token.children) restoreLiteralCitations(token.children);
  }
}

/// 인용 바로 양쪽에 같은 강조 마커(`**`·`*`·`***`·`__`·`_`·`~~`)가 정확히
/// 붙어 있으면 감쌀 태그와 마커를 돌려준다. 여는 마커의 구분자 항목과
/// 텍스트 토큰은 제거한다 — 짝이 사라진 마커는 리터럴로 새어 나오므로.
function citationEmphasisWrap(state: StateInline, pos: number, after: number): { tags: string[]; markup: string } | null {
  const src = state.src;
  const openChar = src[pos - 1];
  if (openChar !== "*" && openChar !== "_" && openChar !== "~") return null;
  let start = pos;
  while (start > 0 && src[start - 1] === openChar) start--;
  const len = pos - start;
  // ~ 는 취소선이 2글자뿐, *·_ 런은 1..3글리만.
  if (openChar === "~" ? len !== 2 : len < 1 || len > 3) return null;
  // 앞이 같은 글자로 더 이어지거나(****) 이스케이프면 그대로 둔다.
  if (start > 0 && (src[start - 1] === openChar || src[start - 1] === "\\")) return null;
  // 닫는 런이 같은 글자·같은 길이로 바로 뒤에 와야 한다.
  for (let i = 0; i < len; i++) if (src[after + i] !== openChar) return null;
  if (src[after + len] === openChar) return null;
  // 여는 런의 구분자 항목(*·_ 는 글자당 하나, ~ 는 런 전체가 하나)과
  // 각 항목이 가리키는 텍스트 토큰을 함께 지운다.
  const delimiters = state.delimiters;
  const marker = openChar.charCodeAt(0);
  const victims: number[] = [];
  let remaining = len;
  for (let i = delimiters.length - 1; i >= 0 && remaining > 0; i--) {
    const entry = delimiters[i];
    if (entry.marker !== marker) return null;
    const token = state.tokens[entry.token];
    if (!token || token.type !== "text" || !token.content || !Array.from(token.content).every((c) => c === openChar)) return null;
    remaining -= token.content.length;
    victims.push(entry.token);
  }
  if (remaining !== 0 || victims.length === 0) return null;
  delimiters.length -= victims.length;
  for (const index of victims) state.tokens[index].content = "";
  const tags = openChar === "~" ? ["s"] : len === 1 ? ["em"] : len === 2 ? ["strong"] : ["strong", "em"];
  return { tags, markup: openChar.repeat(len) };
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
    if (info === "mermaid" && opts.renderDiagrams !== false) {
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

  // 서지는 블록 토큰으로 만들어 항목 안 인라인 서식과 부모 목록을 유지한다.
  // 원문 줄 번호는 Markdown-it의 CRLF → LF 정규화 이후에도 동일하다.
  const numbering = citeNumbering(markdown);
  const definitions = new Map(numbering.definitions.map((definition) => [definition.line - 1, definition]));
  md.block.ruler.before("reference", "iyagi_bibliography", (state, startLine, _endLine, silent) => {
    const definition = definitions.get(startLine);
    if (!definition || state.sCount[startLine] - state.blkIndent >= 4) return false;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const prefix = `[@${definition.key}]:`;
    if (!state.src.startsWith(prefix, start)) return false;
    if (silent) return true;

    const open = state.push("paragraph_open", "p", 1);
    open.map = [startLine, startLine + 1];
    open.meta = { iyagiBibliography: true };
    open.attrSet("class", "ref-entry");
    if (numbering.defs.get(definition.key)?.line === definition.line) {
      open.attrSet("id", `ref-${definition.key}`);
    }
    const inline = state.push("inline", "", 0);
    inline.map = open.map;
    inline.content = state.src.slice(start + prefix.length, state.eMarks[startLine]).replace(/^[ \t]*/, "");
    inline.children = [];
    inline.meta = { iyagiBibliography: true, number: numbering.num.get(definition.key) };
    state.push("paragraph_close", "p", -1).meta = { iyagiBibliography: true };
    state.line = startLine + 1;
    return true;
  }, { alt: ["paragraph", "reference", "blockquote"] });
  md.core.ruler.after("inline", "iyagi_bibliography_inline", (state) => {
    for (const token of state.tokens) {
      const meta = token.meta as { iyagiBibliography?: boolean; number?: number } | null;
      if (!meta?.iyagiBibliography) continue;
      // Tight lists hide paragraph tags, which would also discard bibliography IDs.
      token.hidden = false;
      if (token.type !== "inline" || !token.children) continue;
      restoreLiteralCitations(token.children);
      if (meta.number !== undefined) {
        const number = new state.Token("iyagi_ref_number", "", 0);
        number.content = String(meta.number);
        token.children.unshift(number);
      }
    }
  });

  // 콜아웃 — 인용문 첫 문단이 `[!유형](+/-)? 제목`이면 카드 구조로 재조립.
  // 표준 토큰(div/p/text)만 써서 html:false 렌더에서도 그대로 나온다.
  md.core.ruler.after("inline", "iyagi_callout", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "blockquote_open") continue;
      const po = tokens[i + 1], inline = tokens[i + 2], pc = tokens[i + 3];
      if (po?.type !== "paragraph_open" || inline?.type !== "inline" || !inline.children || pc?.type !== "paragraph_close") continue;
      // 첫 인라인 텍스트(softbreak 전까지)에서 마커를 읽는다 — 지연 연속으로
      // 문단이 여러 줄이어도 children 수술로 첫 줄만 떼어 낸다.
      const first = inline.children.find((child) => child.type === "text");
      if (!first) continue;
      const marker = /^\[!([\w-]+)\]([+-])?[ \t]*(.*)$/.exec(first.content);
      if (!marker) continue;
      const key = calloutKeyOf(marker[1]!);
      const title = marker[3] ?? "";
      // 첫 줄(마커+제목)과 그 softbreak를 children에서 제거 — 남은 줄이
      // 있으면 그 문단을 본문으로 보존한다.
      const cut = inline.children.indexOf(first);
      const softbreak = inline.children[cut + 1];
      const rest = inline.children.slice(softbreak?.type === "softbreak" ? cut + 2 : cut + 1);
      const hasRest = rest.some((child) => child.type === "text" && child.content.trim());
      const card = new state.Token("div_open", "div", 1);
      card.attrSet("class", `callout callout-${key}`);
      card.attrSet("data-callout", key);
      const titleOpen = new state.Token("p_open", "p", 1);
      titleOpen.attrSet("class", "callout-title");
      const titleText = new state.Token("text", "", 0);
      titleText.content = `${CALLOUT_ICONS[key] ?? "📝"} ${title}`.trim();
      const titleInline = new state.Token("inline", "", 0);
      titleInline.content = titleText.content;
      titleInline.children = [titleText];
      const titleClose = new state.Token("p_close", "p", -1);
      const contentOpen = new state.Token("div_open", "div", 1);
      contentOpen.attrSet("class", "callout-content");
      if (hasRest) {
        inline.children = rest;
        inline.content = rest.map((child) => child.content).join("\n");
        tokens.splice(i, 1, card, titleOpen, titleInline, titleClose, contentOpen, po);
      } else {
        tokens.splice(i, 4, card, titleOpen, titleInline, titleClose, contentOpen);
      }
      // 같은 깊이의 blockquote_close → 두 개의 div_close.
      let depth = 0;
      for (let j = i + 5; j < tokens.length; j++) {
        if (tokens[j].type === "blockquote_open") depth++;
        else if (tokens[j].type === "blockquote_close") {
          if (depth > 0) { depth--; continue; }
          tokens.splice(j, 1,
            new state.Token("div_close", "div", -1),
            new state.Token("div_close", "div", -1));
          break;
        }
      }
    }
  });
  md.renderer.rules.iyagi_ref_number = (tokens, idx) =>
    `<span class="ref-num">[${escapeHtml(tokens[idx].content)}]</span> `;

  // 본문 [@key]는 [N] 위첨자 링크로(첫 등장 순 번호).
  md.inline.ruler.before("escape", "iyagi_cite", (state: StateInline, silent: boolean) => {
    const src = state.src;
    const pos = state.pos;
    if (state.linkLevel > 0 || src[pos - 1] === "[") return false;
    if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x40 /* @ */) return false;
    const close = src.indexOf("]", pos + 2);
    if (close === -1 || src[close + 1] === "]") return false;
    const inner = src.slice(pos + 2, close);
    const comma = inner.indexOf(",");
    const key = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const suffix = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    if (!key || /[\s\[\]]/.test(key) || /[\[\r\n]/.test(inner)) return false;
    const display = citeDisplay(key, suffix, numbering);
    if (display === null) return false; // 정의 없는 인용 — 원문 그대로
    // CommonMark 플랭킹 규칙상 `**[@key]**글자`는 닫는 마커가 짝이 되지
    // 않아 리터럴 ** 로 남는다(한국어 붙여쓰기에서 항상 그렇다). 양쪽에
    // 같은 마커가 정확히 붙어 있으면 마커 토큰을 치우고 직접 감싼다.
    const wrap = !silent ? citationEmphasisWrap(state, pos, close + 1) : null;
    if (!silent) {
      if (wrap) for (const tag of wrap.tags) state.push(`${tag}_open`, tag, 1).markup = wrap.markup;
      const token = state.push("iyagi_cite", "", 0);
      token.content = display;
      token.meta = { key, raw: src.slice(pos, close + 1) };
      if (wrap) {
        for (const tag of wrap.tags.slice().reverse()) state.push(`${tag}_close`, tag, -1).markup = wrap.markup;
      }
    }
    state.pos = close + 1 + (wrap ? wrap.markup.length : 0);
    return true;
  });
  md.renderer.rules.iyagi_cite = (tokens: Token[], idx: number) => {
    const t = tokens[idx];
    const key = (t.meta as { key: string }).key;
    return `<sup class="cite"><a href="#ref-${escapeHtml(key)}">${escapeHtml(t.content)}</a></sup>`;
  };
  // Markdown-it parses an image label with a fresh inline state. Restore any
  // citation tokens there before its text-only alt renderer consumes them.
  const imageRenderer = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, renderer) => {
    restoreLiteralCitations(tokens[idx].children ?? []);
    return imageRenderer(tokens, idx, options, env, renderer);
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



/** 목차 라벨 — UI 언어별. */
export function frontLabels(lang: "ko" | "en"): { toc: string; lof: string; lot: string } {
  return lang === "en"
    ? { toc: "Contents", lof: "List of Figures", lot: "List of Tables" }
    : { toc: "목차", lof: "그림 목차", lot: "표 목차" };
}

/** 렌더된 본문에서 정적 목차(목차·그림·표) 조립 — 제목/캡션 id로 링크.
 *  순수 함수 — 렌더러가 심은 id와 짝 맞추기(테스트 대상). */
export function buildFrontLists(
  html: string,
  want: { toc: boolean; lof: boolean; lot: boolean },
  labels?: { toc: string; lof: string; lot: string },
): string {
  const L = labels ?? frontLabels("ko");
  const out: string[] = [];
  if (want.toc) {
    const items: string[] = [];
    for (const m of html.matchAll(/<h([1-3]) id="([^"]+)">([\s\S]*?)<\/h\1>/g)) {
      const text = m[3]!.replace(/<[^>]+>/g, "").trim();
      items.push(`<li class="fl-l${m[1]}"><a href="#${m[2]}">${text}</a></li>`);
    }
    if (items.length > 0) {
      out.push(`<nav class="doc-front"><h2>${L.toc}</h2><ol>${items.join("")}</ol></nav>`);
    }
  }
  const captionList = (kind: "fig" | "tbl", label: string): string => {
    const items: string[] = [];
    const re = new RegExp(`<figure[^>]*id="${kind}-(\\d+)"[\\s\\S]*?</figure>`, "g");
    for (const m of html.matchAll(re)) {
      const cap = /<figcaption>([\s\S]*?)<\/figcaption>/.exec(m[0])?.[1] ?? "";
      items.push(`<li><a href="#${kind}-${m[1]}">${cap}</a></li>`);
    }
    return items.length > 0
      ? `<nav class="doc-front"><h2>${label}</h2><ol>${items.join("")}</ol></nav>`
      : "";
  };
  if (want.lof) out.push(captionList("fig", L.lof));
  if (want.lot) out.push(captionList("tbl", L.lot));
  return out.join("");
}

/** PDF 페이지 장식(머리글·바닥글) 조각 — 순수 함수. WebKit createPDF는
 *  fixed 요소를 한 번만 렌더하므로, JS가 컬럼마다 absolute 요소를 심는다.
 *  제목은 JSON 리터럴로 넣고 </script>만 이스케이프(태그 탈출 방지). */
export function pdfPageChrome(
  pageNumbers: boolean,
  headerTitle: string | null,
  footerText: string | null = null,
): { css: string; body: string; script: string } {
  const showNum = pageNumbers;
  const showHead = !!headerTitle;
  const showFoot = !!footerText;
  if (!showNum && !showHead && !showFoot) return { css: "", body: "", script: "" };
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
  const body = `${showNum || showFoot ? `<div class="pdf-pagenum" aria-hidden="true"></div>` : ""}${showHead ? `<div class="pdf-head" aria-hidden="true"></div>` : ""}`;
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
  var FOOTER = ${showFoot ? JSON.stringify(footerText).replace(/<\//g, "<\\/") : "null"};
  for (var i = 1; i <= total; i++) {
    var left = ((i - 1) * (colW + gap)) + 'px';
    var width = colW + 'px';
    ${showNum || showFoot ? `if (numHost) {
      var n = document.createElement('div');
      n.className = 'pdf-pagenum-data';
      n.style.left = left; n.style.width = width;
      n.style.top = (wrap.offsetHeight - 24) + 'px';
      n.style.textAlign = 'center'; n.style.fontSize = '9px'; n.style.color = '#888';
      var core = ${showNum} ? (i + suffix) : '';
      n.textContent = FOOTER ? (core ? FOOTER + ' \u00b7 ' + core : FOOTER) : core;
      wrap.appendChild(n);
    }` : ""}
    ${showHead ? `if (headHost && i > 1) { // 표지(1쪽)엔 본문 H1이 있어 머리글 생략
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


/** 캡션 후보 alt를 <figure><figcaption>로 — 문서 순서대로 '그림 N — 설명'.
 *  markdown-it의 <p><img></p>를 변환하고, style(img 폭)은 그대로 옮긴다.
 *  라벨은 내보내기 언어를 따른다(기본 한국어 — 목차 라벨과 같은 규칙). */
export function applyFigcaptions(html: string, lang: "ko" | "en" = "ko"): string {
  const label = lang === "en" ? "Figure" : "그림";
  let n = 0;
  return html.replace(/<p>(<img\b[^>]*>)<\/p>/g, (_m, img: string) => {
    const alt = / alt="([^"]*)"/.exec(img)?.[1] ?? "";
    // alt는 markdown-it가 이미 이스케이프한 값 — 그대로 figcaption에 쓴다.
    if (!captionWorthy(alt.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'))) {
      return `<p>${img}</p>`;
    }
    n += 1;
    return `<figure id="fig-${n}">${img}<figcaption>${label} ${n} — ${alt}</figcaption></figure>`;
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

export async function renderExportBody(markdown: string, opts: ExportHtmlOptions): Promise<string> {
  // 프론트매터는 메타 — 인쇄·HTML 본문에서 제외한다(모든 호출 경로의 공통 끝점).
  // 위키링크는 표준 마크다운 링크로(resolve 미제공이면 이름.md 참조).
  const body0 = wikiLinksToMarkdown(
    stripFrontMatter(markdown),
    opts.wikiResolve ?? (() => null),
    opts.baseDir,
  );
  const { body } = await renderMarkdownBody(body0, opts);
  // 사이드카 폭은 원본 src 키로 매칭 — data URI 인라인化 전에 적용한다.
  const withWidths = applyTableWidths(
    applyImageWidths(body, opts.imageWidths ?? {}),
    opts.tableWidths ?? {},
  );
  const withImages = opts.inlineImages === false
    ? withWidths
    : await inlineImages(withWidths, opts.baseDir, opts.readBytes);
  const withCaptions = applyFigcaptions(applyTableCaptions(withImages, opts.lang ?? "ko"), opts.lang ?? "ko");
  // 외부 링크 새 탭 — 내부 앵커(#...)는 그대로.
  const withTargets = opts.externalLinksNewTab
    ? withCaptions.replace(/<a (?![^>]*target=)(href="https?:[^"]*")/g, '<a $1 target="_blank" rel="noopener"')
    : withCaptions;
  const sanitized = await sanitize(opts.preRendered ?? withTargets);
  return sanitized;
}

export async function buildExportHtml(markdown: string, opts: ExportHtmlOptions): Promise<string> {
  const sanitized = opts.preRendered ?? (await renderExportBody(markdown, opts));
  // 다단(프런트매터 columns: 1~3) — Word Layout > Columns. PDF 타일링은
  // pdf.rs가 data-columns로 컬럼 폭을 재계산한다.
  const columns = frontMatterMeta(markdown)?.columns ?? 1;
  const katexCss = await inlineKatexCss();
  // 문서 앞 목차(정적) — DOCX의 TOC/lof/lot 필드와 같은 자리.
  const front = opts.frontLists
    ? buildFrontLists(sanitized, opts.frontLists, frontLabels(opts.lang ?? "ko"))
    : "";
  const marginCss = opts.forPdf
    ? `body{margin:${opts.marginMm ?? 14}mm !important;}` +
      `html{font-size:${(16 * (opts.scale ?? 1)).toFixed(1)}px;}` +
      `@page{size:${opts.paper === "letter" ? "letter" : opts.paper === "a5" ? "A5" : "A4"} ${opts.orientation === "landscape" ? "landscape" : "portrait"};margin:0;}`
    : "";
  const columnCss =
    columns > 1
      ? `.markdown-body{column-count:${columns};column-gap:2.4em;}` +
        `.markdown-body h1,.markdown-body h2{column-span:all;}`
      : "";
  // 페이지 장식(머리글·바닥글) — 고정 위치 요소가 WebKit createPDF에서 매
  // "페이지"(=컬럼)에 반복 나타나지는 않으므로 JS가 컬럼마다 absolute로 심는다.
  const chrome = opts.forPdf
    ? pdfPageChrome(!!opts.pageNumbers, opts.pdfHeader ?? null, opts.pdfFooter ?? null)
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
        : ``) +
      (st.highlightColor
        ? `.markdown-body mark, .markdown-body .hl{background:rgba(${parseInt(st.highlightColor.slice(0, 2), 16)}, ${parseInt(st.highlightColor.slice(2, 4), 16)}, ${parseInt(st.highlightColor.slice(4, 6), 16)}, 0.38);}`
        : ``)
    : "";
  return `<!doctype html>
<html lang="${opts.lang === "en" ? "en" : "ko"}">
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
${columnCss}
</style>
</head>
<body>
${chrome.body}
${opts.forPdf ? "" : `<header class="doc-header"><h1>${escapeHtml(opts.title)}</h1></header>`}
${front}<article class="markdown-body" data-columns="${columns}">
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
.markdown-body .callout{margin:.9em 0;border-radius:8px;border-left:4px solid #9e9e9e;background:rgba(127,127,127,.08);padding:8px 14px;break-inside:avoid;}
.markdown-body .callout-title{margin:0 0 2px;font-weight:600;}
.markdown-body .callout-content > :first-child{margin-top:2px;}
.markdown-body .callout-content > :last-child{margin-bottom:2px;}
.markdown-body .callout-note{border-left-color:#448aff;background:rgba(68,138,255,.10);}
.markdown-body .callout-info{border-left-color:#3ba9f0;background:rgba(59,169,240,.10);}
.markdown-body .callout-abstract{border-left-color:#00bfbc;background:rgba(0,191,188,.10);}
.markdown-body .callout-todo{border-left-color:#f9b24a;background:rgba(249,178,74,.12);}
.markdown-body .callout-tip{border-left-color:#00c9a7;background:rgba(0,201,167,.10);}
.markdown-body .callout-success{border-left-color:#3fb950;background:rgba(63,185,80,.12);}
.markdown-body .callout-question{border-left-color:#ba832c;background:rgba(186,131,44,.12);}
.markdown-body .callout-warning{border-left-color:#e9a23b;background:rgba(233,162,59,.13);}
.markdown-body .callout-failure{border-left-color:#e5484d;background:rgba(229,72,77,.10);}
.markdown-body .callout-danger{border-left-color:#f5493d;background:rgba(245,73,61,.11);}
.markdown-body .callout-bug{border-left-color:#e5484d;background:rgba(229,72,77,.10);}
.markdown-body .callout-example{border-left-color:#a882ff;background:rgba(168,130,255,.11);}
.markdown-body .callout-quote{border-left-color:#9e9e9e;background:rgba(127,127,127,.08);}
.markdown-body table{border-collapse:collapse;margin:1em 0;display:block;max-width:100%;overflow-x:auto;}
.markdown-body th,.markdown-body td{border:1px solid ${c.border};padding:6px 14px;}
.markdown-body th{background:${c.codeBg};font-weight:600;}
.markdown-body img{max-width:100%;border-radius:6px;}
.markdown-body figure{margin:1.2em 0;text-align:center;}
.doc-front{margin:1.4em 0;padding:14px 18px;border:1px solid rgba(127,127,127,.18);border-radius:10px;}
.doc-front h2{margin:0 0 8px;font-size:1.05em;}
.doc-front ol{margin:0;padding-left:20px;}
.doc-front li{margin:3px 0;}
.doc-front .fl-l2{margin-left:14px;}
.doc-front .fl-l3{margin-left:28px;}
.markdown-body figcaption{font-size:.85em;color:#8a919c;margin-top:.45em;}
.markdown-body figure.tbl-fig{margin:1.2em 0;}
.markdown-body figure.tbl-fig table{margin:0;}
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
.markdown-body .page-break{break-before:page;border-top:1px dashed #c0c4cc;margin:1.6em 0;}
.markdown-body sup.cite{font-size:0.72em;line-height:1;}
.markdown-body sup.cite a{text-decoration:none;color:inherit;}
.markdown-body .ref-entry{font-size:0.92em;margin:0.35em 0;padding-left:1.6em;text-indent:-1.6em;}
.markdown-body .ref-num{font-weight:600;}
@media print{.markdown-body .page-break{border-top:none;margin:0;}}
`.trim();
}

/** DOCX 내보내기용 매니페스트(수식 MathML·다이어그램 SVG) — §4-4. */
export async function buildDocxManifest(
  markdown: string,
): Promise<DocxManifest> {
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
