// 제목 이름 변경 → 위키링크 앵커 갱신([[문서#앵커]]의 앵커를 새 슬러그로).
// 순수 함수(테스트 대상). 문서 버퍼 수정은 호출자가, 디스크 반영은
// writeDocument(kind:"match") 기대값으로 안전하게 한다.

import type { EditorState } from "@codemirror/state";
import { slugifyHeading } from "../links";

/** 커서가 있는 ATX 제목 — 없으면 null. */
export function headingAtCursor(state: EditorState): {
  from: number;
  to: number;
  title: string;
} | null {
  const line = state.doc.lineAt(state.selection.main.head);
  const m = /^(#{1,6})\s+(.*)$/.exec(line.text);
  if (!m || !m[2]!.trim()) return null;
  return { from: line.from, to: line.to, title: m[2]!.trim() };
}

/** 한 파일의 텍스트에서 이 문서를 가리키는 앵커 링크를 새 슬러그로.
 *  docStem: 이 문서의 stem(같은 문서 내 `[[#앵커]]`도 갱신).
 *  변경이 없으면 null. */
export function retargetHeadingLinks(
  text: string,
  docStem: string,
  oldTitle: string,
  newTitle: string,
): string | null {
  const oldSlug = slugifyHeading(oldTitle);
  const newSlug = slugifyHeading(newTitle);
  if (!oldSlug || !newSlug || oldSlug === newSlug) return null;
  let changed = false;
  const out = text.replace(/\[\[([^\]\n]+)\]\]/g, (whole, inner: string) => {
    const hash = inner.indexOf("#");
    if (hash < 0) return whole; // 앵커 없음 — hash 0(이름 없는 같은 문서)은 대상
    const name = inner.slice(0, hash).trim();
    const anchor = inner.slice(hash + 1).split("|")[0]!.trim();
    if (anchor !== oldTitle && anchor !== oldSlug) return whole;
    // 대상 문서가 이 문서인지 — 이름 없는 `[[#앵커]]`는 같은 문서다.
    const targetThis = name === docStem || name === `/${docStem}` || name === "";
    if (!targetThis) return whole;
    changed = true;
    const display = inner.slice(hash + 1).includes("|")
      ? `|${inner.split("|")[1] ?? ""}`
      : "";
    return `[[${name}#${newTitle}${display}]]`;
  });
  return changed ? out : null;
}

/** 제목 줄 재작성 — 같은 수준 표시를 유지하고 텍스트만 바꾼다. */
export function rewrittenHeadingLine(lineText: string, newTitle: string): string {
  const m = /^(#{1,6})\s+/.exec(lineText);
  return m ? `${m[1]} ${newTitle}` : `# ${newTitle}`;
}

/** 이 제목을 가리키는 링크 수 — 대화상자 안내용(변경은 하지 않는다). */
export function countHeadingLinks(text: string, docStem: string, title: string): number {
  const slug = slugifyHeading(title);
  if (!slug) return 0;
  let count = 0;
  for (const m of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const inner = m[1]!;
    const hash = inner.indexOf("#");
    if (hash < 0) continue; // hash===0(이름 없는 같은 문서)도 대상
    const name = inner.slice(0, hash).trim();
    const anchor = inner.slice(hash + 1).split("|")[0]!.trim();
    if (anchor !== title && anchor !== slug) continue;
    if (name === docStem || name === `/${docStem}` || name === "") count++;
  }
  return count;
}
