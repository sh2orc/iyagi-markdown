// EPUB chapters use an inert DOM fragment. Split only at root h1 elements so
// quotations/lists remain intact, then resolve fragments across all chapter files.
import { percentDecode, resolveLink } from "../links";

export interface EpubChapterInput {
  title: string;
  body: string;
  file: string;
  sections: Array<{ anchor: string; title: string }>;
}

function parseFragment(html: string): HTMLTemplateElement {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template;
}

/** Choose the first rendered local image, including reference-style Markdown images. */
export function firstEpubLocalImage(body: string, baseDir: string): string | null {
  for (const image of parseFragment(body).content.querySelectorAll("img[src]")) {
    const url = image.getAttribute("src")?.trim() ?? "";
    if (!url || url.startsWith("//") || url.startsWith("#")) continue;
    const target = resolveLink(url.split(/[?#]/, 1)[0], baseDir);
    if (target.kind === "asset") return target.path;
  }
  return null;
}

function serializeXhtml(fragment: DocumentFragment): string {
  const serializer = new XMLSerializer();
  return [...fragment.childNodes].map((node) => serializer.serializeToString(node)).join("");
}

/** Serialize HTML entities, void elements and SVG/MathML namespaces as XML. */
export function toXhtml(frag: string): string {
  return serializeXhtml(parseFragment(frag).content);
}

function sectionsIn(fragment: DocumentFragment): Array<{ anchor: string; title: string }> {
  return [...fragment.querySelectorAll("h2[id]")]
    .filter((heading) => heading.id.length > 0)
    .map((heading) => ({ anchor: heading.id, title: heading.textContent?.trim() ?? "" }));
}

/** 챕터 안 h2 섹션 — (앵커 id, 디코딩된 표시 제목). */
export function h2Sections(chunk: string): Array<{ anchor: string; title: string }> {
  return sectionsIn(parseFragment(chunk).content);
}

/** 렌더된 본문의 최상위 <h1>마다 챕터로. 앞 내용은 서문 챕터(있을 때만).
 *  h1이 없으면 한 챕터. sections는 챕터 안 h2(EPUB 목차 depth용). */
export function splitEpubChapters(
  bodyHtml: string,
): Array<{ title: string; body: string; sections: Array<{ anchor: string; title: string }> }> {
  const source = parseFragment(bodyHtml);
  const out: Array<{ title: string; body: string; sections: Array<{ anchor: string; title: string }> }> = [];
  let chapter = parseFragment("");
  let title = "";
  const flush = () => {
    const body = chapter.innerHTML.trim();
    if (body) out.push({ title, body, sections: sectionsIn(chapter.content) });
    chapter = parseFragment("");
  };
  for (const node of [...source.content.childNodes]) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).localName === "h1") {
      flush();
      title = node.textContent?.trim() ?? "";
    }
    chapter.content.appendChild(node);
  }
  flush();
  if (out.length === 0) return [{ title: "", body: bodyHtml, sections: [] }];
  // 서문(제목 없는 앞 덩어리)이 하나뿐이고 본문이 없으면 단일 챕터로.
  if (out.length === 1 && !out[0].title) return out;
  // 빈 제목 챕터에 이름 부여.
  return out.map((c, i) => ({
    title: c.title || `Section ${i + 1}`,
    body: c.body,
    sections: c.sections,
  }));
}

/** 챕터 배열을 EpubChapterInput(file 이름 포함)으로. */
export function epubChapterInputs(
  chapters: Array<{ title: string; body: string; sections: Array<{ anchor: string; title: string }> }>,
): EpubChapterInput[] {
  const fragments = chapters.map((chapter) => parseFragment(chapter.body));
  const files = chapters.map((_, i) => `chapter${i + 1}.xhtml`);
  const destinations = new Map<string, number>();
  for (const [i, fragment] of fragments.entries()) {
    for (const element of fragment.content.querySelectorAll("[id],a[name]")) {
      for (const id of [element.getAttribute("id"), element.localName === "a" ? element.getAttribute("name") : null]) {
        if (id && !destinations.has(id)) destinations.set(id, i);
      }
    }
  }
  for (const [i, fragment] of fragments.entries()) {
    for (const link of fragment.content.querySelectorAll("a[href],area[href]")) {
      const href = link.getAttribute("href")?.trim() ?? "";
      if (!href.startsWith("#")) continue;
      const target = href.length === 1 ? 0 : destinations.get(percentDecode(href.slice(1)));
      if (target !== undefined && target !== i) {
        link.setAttribute("href", `${files[target]}${href.length === 1 ? "" : href}`);
      }
    }
  }
  return chapters.map((c, i) => ({
    title: c.title,
    body: serializeXhtml(fragments[i].content),
    file: files[i],
    sections: c.sections,
  }));
}

/** 전자책 본문용 최소 가독 CSS — 읽기 모드 톤과 같은 방향.
 *  글자색을 지정하면 다크 모드 리더(Apple Books 등)에서 어두운 배경에
 *  검은 글자가 될 수 있다 — 배경은 리더 소관으로 두고 글자·구분선만
 *  prefers-color-scheme으로 반전한다(EPUB3 미디어쿼리 지원 기준). */
export const EPUB_CSS = `body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans KR",sans-serif;line-height:1.7;margin:0 6%;color:#1a1a1a}h1{font-size:1.6em;margin:1.4em 0 .6em}h2{font-size:1.35em;margin:1.3em 0 .5em}h3{font-size:1.15em}p{margin:.8em 0}img{max-width:100%;height:auto}code{font-family:Menlo,monospace;font-size:.88em;background:rgba(0,0,0,.05);padding:.1em .3em;border-radius:3px}pre{background:rgba(0,0,0,.05);padding:12px;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}blockquote{border-left:3px solid rgba(0,0,0,.15);margin:1em 0;padding-left:1em;color:#555}table{border-collapse:collapse;margin:1em 0}td,th{border:1px solid rgba(0,0,0,.2);padding:6px 10px}mark{background:#ffd60a55}a{color:#0a6cd6}@media (prefers-color-scheme: dark){body{color:#e6e6e6}code{background:rgba(255,255,255,.08)}pre{background:rgba(255,255,255,.08)}blockquote{color:#b0b0b0;border-left-color:rgba(255,255,255,.25)}td,th{border-color:rgba(255,255,255,.25)}a{color:#6db3ff}}`;
