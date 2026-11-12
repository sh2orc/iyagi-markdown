// 제목 이름 변경 → 위키링크 앵커 갱신([[문서#앵커]]의 앵커를 새 슬러그로).
// 순수 함수(테스트 대상). 문서 버퍼 수정은 호출자가, 디스크 반영은
// writeDocument(kind:"match") 기대값으로 안전하게 한다.

import type { EditorState } from "@codemirror/state";
import { collectHeadings, slugifyHeading } from "../links";
import { inRanges, literalRanges } from "./literalRanges";

/** 커서가 있는 ATX 제목 — 없으면 null. 문서 구조에서 찾는다(코드 펜스 안의
 *  `# 주석` 줄은 제목이 아니고, `## 제목 ##`의 닫는 #은 제목 글자가 아니다).
 *  slug는 문서 안 실제 앵커(같은 제목이 여럿이면 `-1`, `-2` …가 붙는다). */
export function headingAtCursor(state: EditorState): {
  from: number;
  to: number;
  title: string;
  slug: string;
} | null {
  const line = state.doc.lineAt(state.selection.main.head);
  if (!/^#{1,6}\s+\S/.test(line.text)) return null;
  const heading = collectHeadings(state.doc.toString()).find((h) => h.pos >= line.from && h.pos <= line.to);
  if (!heading || !heading.text.trim()) return null;
  return { from: line.from, to: line.to, title: heading.text.trim(), slug: heading.slug };
}

const norm = (value: string): string => value.normalize("NFC").toLowerCase();

/** 링크 대상 이름이 이 문서인가 — 이름 없음(같은 문서), stem, 경로/stem. 앱의 위키
 *  해석(대소문자 무시)과 같은 느슨함으로 본다. */
function targetsDoc(name: string, docStem: string): boolean {
  const clean = name.trim().replace(/\\/g, "/").replace(/\.(md|markdown)$/i, "");
  if (clean === "") return true;
  return norm(clean.slice(clean.lastIndexOf("/") + 1)) === norm(docStem);
}

/** 앵커가 이 제목을 가리키는가. 실제 슬러그(`shared-1`)는 글자 그대로, 첫 번째
 *  제목(슬러그 = 기본형)은 제목 글자·다른 표기(`Old Title`·`old title`)로도. */
function anchorMatches(anchor: string, title: string, slug: string): boolean {
  const a = anchor.trim();
  if (norm(a) === norm(slug)) return true;
  return slugifyHeading(title) === slug && slugifyHeading(a) === slug;
}

/** 한 파일의 텍스트에서 이 문서의 제목을 가리키는 링크를 새 제목으로.
 *  위키링크(`[[문서#제목]]`·`[[#제목]]`)와 마크다운 앵커 링크(`](#슬러그)`·
 *  `](문서.md#슬러그)` — 목차 삽입이 만드는 형태) 모두. 코드 안은 그대로.
 *  docStem: 이 문서의 stem. slugs: 문서 안 실제 앵커(중복 제목 구분) — 없으면
 *  제목에서 계산한다. 변경이 없으면 null. */
export function retargetHeadingLinks(
  text: string,
  docStem: string,
  oldTitle: string,
  newTitle: string,
  slugs: { old?: string; next?: string } = {},
): string | null {
  const oldSlug = slugs.old ?? slugifyHeading(oldTitle);
  const newSlug = slugs.next ?? slugifyHeading(newTitle);
  if (!oldSlug || !newSlug) return null;
  // 위키 앵커는 읽기 좋게 제목 글자로 — 단, 문법 글자가 들었거나 슬러그가 제목과
  // 다르면(중복 제목의 -N) 슬러그로 쓴다.
  const wikiAnchor = /[|\]#]/.test(newTitle) || slugifyHeading(newTitle) !== newSlug ? newSlug : newTitle;
  const literal = literalRanges(text);
  let changed = false;
  let out = text.replace(/\[\[([^\]\n]+)\]\]/g, (whole, inner: string, at: number) => {
    if (inRanges(literal, at)) return whole;
    const hash = inner.indexOf("#");
    if (hash < 0) return whole; // 앵커 없음 — hash 0(이름 없는 같은 문서)은 대상
    const name = inner.slice(0, hash);
    const rest = inner.slice(hash + 1);
    const bar = rest.indexOf("|");
    const anchor = bar >= 0 ? rest.slice(0, bar) : rest;
    if (!anchorMatches(anchor, oldTitle, oldSlug) || !targetsDoc(name, docStem)) return whole;
    const next = `[[${name}#${wikiAnchor}${bar >= 0 ? rest.slice(bar) : ""}]]`;
    if (next !== whole) changed = true;
    return next;
  });
  // 마크다운 링크의 조각(#슬러그) — 같은 문서(`](#…)`)와 이 문서 파일(`](…/문서.md#…)`).
  out = out.replace(/\]\((<?)([^)\s>#]*)#([^)\s>]+)/g, (whole, open: string, target: string, fragment: string, at: number) => {
    if (inRanges(literal, at)) return whole;
    let file = target, frag = fragment;
    try { file = decodeURIComponent(target); frag = decodeURIComponent(fragment); } catch { /* 원문 그대로 비교 */ }
    if (/^[a-z][a-z0-9+.-]*:/i.test(file)) return whole; // 외부 URL
    if (norm(frag) !== norm(oldSlug) || !targetsDoc(file, docStem) || frag === newSlug) return whole;
    changed = true;
    return `](${open}${target}#${newSlug}`;
  });
  return changed ? out : null;
}

/** 제목 줄 재작성 — 같은 수준 표시를 유지하고 텍스트만 바꾼다. */
export function rewrittenHeadingLine(lineText: string, newTitle: string): string {
  const m = /^(#{1,6})\s+/.exec(lineText);
  return m ? `${m[1]} ${newTitle}` : `# ${newTitle}`;
}

/** 이 제목을 가리키는 링크 수 — 대화상자 안내용(변경은 하지 않는다).
 *  retargetHeadingLinks와 같은 판정을 쓴다. */
export function countHeadingLinks(text: string, docStem: string, title: string, slug = slugifyHeading(title)): number {
  if (!slug) return 0;
  const literal = literalRanges(text);
  let count = 0;
  for (const m of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    if (inRanges(literal, m.index)) continue;
    const inner = m[1]!;
    const hash = inner.indexOf("#");
    if (hash < 0) continue; // hash===0(이름 없는 같은 문서)도 대상
    const anchor = inner.slice(hash + 1).split("|")[0]!;
    if (anchorMatches(anchor, title, slug) && targetsDoc(inner.slice(0, hash), docStem)) count++;
  }
  for (const m of text.matchAll(/\]\(<?([^)\s>#]*)#([^)\s>]+)/g)) {
    if (inRanges(literal, m.index)) continue;
    let file = m[1]!, frag = m[2]!;
    try { file = decodeURIComponent(file); frag = decodeURIComponent(frag); } catch { /* 원문 그대로 */ }
    if (/^[a-z][a-z0-9+.-]*:/i.test(file)) continue;
    if (norm(frag) === norm(slug) && targetsDoc(file, docStem)) count++;
  }
  return count;
}
