// EPUB 챕터 분할·XHTML화 — 순수 함수(렌더러 의존 없음, 노드 테스트).
// 챕터는 렌더된 HTML을 <h1> 경계로 나눈다: 전체를 한 번 렌더해 각주·수식이
// 문서 전역에서 동작하게 하고, 분할은 태그 경계에서만(코드 블록 안의
// 이스케이프된 "# 제목"은 태그가 아니므로 영향 없다).

export interface EpubChapterInput {
  title: string;
  body: string;
  file: string;
  sections: Array<{ anchor: string; title: string }>;
}

/** HTML5 조각을 XHTML로 — 빈 요소 자가 폐쇄(markdown-it 출력 정규화). */
export function toXhtml(frag: string): string {
  return frag.replace(/<(br|hr|img|input)\b([^>]*?)(?<!\/)>/gi, "<$1$2/>");
}

function h1Title(chunk: string): string {
  const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(chunk);
  if (!m) return "";
  return m[1].replace(/<[^>]+>/g, "").trim();
}

/** 챕터 안 h2 섹션 — (앵커 id, 제목). 순수 함수. */
export function h2Sections(chunk: string): Array<{ anchor: string; title: string }> {
  const out: Array<{ anchor: string; title: string }> = [];
  for (const m of chunk.matchAll(/<h2([^>]*)>([\s\S]*?)<\/h2>/gi)) {
    const idm = /id="([^"]+)"/.exec(m[1]);
    if (!idm) continue;
    out.push({ anchor: idm[1], title: m[2].replace(/<[^>]+>/g, "").trim() });
  }
  return out;
}

/** 렌더된 본문을 <h1>마다 챕터로. 첫 h1 앞 내용은 서문 챕터(있을 때만).
 *  h1이 없으면 한 챕터. sections는 챕터 안 h2(EPUB 목차 depth용). */
export function splitEpubChapters(
  bodyHtml: string,
): Array<{ title: string; body: string; sections: Array<{ anchor: string; title: string }> }> {
  const parts = bodyHtml.split(/(?=<h1[\s>])/i);
  const out: Array<{ title: string; body: string; sections: Array<{ anchor: string; title: string }> }> = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const title = h1Title(part);
    const body = part.trim();
    out.push({ title, body, sections: h2Sections(body) });
  }
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
  return chapters.map((c, i) => ({
    title: c.title,
    body: toXhtml(c.body),
    file: `chapter${i + 1}.xhtml`,
    sections: c.sections,
  }));
}

/** 전자책 본문용 최소 가독 CSS — 읽기 모드 톤과 같은 방향. */
export const EPUB_CSS = `body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans KR",sans-serif;line-height:1.7;margin:0 6%;color:#1a1a1a}h1{font-size:1.6em;margin:1.4em 0 .6em}h2{font-size:1.35em;margin:1.3em 0 .5em}h3{font-size:1.15em}p{margin:.8em 0}img{max-width:100%;height:auto}code{font-family:Menlo,monospace;font-size:.88em;background:rgba(0,0,0,.05);padding:.1em .3em;border-radius:3px}pre{background:rgba(0,0,0,.05);padding:12px;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}blockquote{border-left:3px solid rgba(0,0,0,.15);margin:1em 0;padding-left:1em;color:#555}table{border-collapse:collapse;margin:1em 0}td,th{border:1px solid rgba(0,0,0,.2);padding:6px 10px}mark{background:#ffd60a55}a{color:#0a6cd6}`;
