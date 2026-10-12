// $…$ 인라인 수식, $$…$$ 블록 수식, [^label] 각주 참조를 lezer-markdown에
// 추가하는 확장. 문법 요소만 만들고 표시는 livePreview 장식이 맡는다.

import { MarkdownExtension } from "@lezer/markdown";

const DOLLAR = 36;
const BACKSLASH = 92;

export const mathSyntax: MarkdownExtension = {
  defineNodes: [
    { name: "InlineMath" },
    { name: "MathBlock", block: true },
    { name: "FootnoteRef" },
    { name: "Highlight" },
  ],
  parseInline: [
    {
      // ==하이라이트== (Obsidian). 여는 == 뒤 공백/줄바꿈 아니고 같은 줄에서 닫힌다.
      name: "iyagiHighlight",
      before: "Escape",
      parse(cx, next, pos) {
        if (next !== 0x3d /* = */ || cx.char(pos + 1) !== 0x3d) return -1;
        const after = cx.char(pos + 2);
        if (after === 32 || after === 10 || after === 9 || after === -1 || after === 0x3d) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 0x0a) return -1; // 줄 안에서 닫혀야 한다
          if (c === 0x3d && cx.char(i + 1) === 0x3d) {
            return cx.addElement(cx.elt("Highlight", pos, i + 2));
          }
        }
        return -1;
      },
    },
    {
      // 각주 참조 [^label] — Link 파서보다 먼저 잡는다.
      name: "iyagiFootnoteRef",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 0x5b /* [ */ || cx.char(pos + 1) !== 0x5e /* ^ */) return -1;
        for (let i = pos + 2; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 0x5d /* ] */) {
            if (i <= pos + 2) return -1; // [^] 는 각주 아님
            return cx.addElement(cx.elt("FootnoteRef", pos, i + 1));
          }
          if (c === 0x0a || c === 0x20) return -1; // 줄바꿈·공백은 라벨에 없다
        }
        return -1;
      },
    },
    {
      name: "mathInline",
      before: "Escape",
      parse(cx, next, pos) {
        if (next !== DOLLAR || cx.char(pos + 1) === DOLLAR) return -1;
        // 여는 $ 바로 뒤가 공백이면 화폐 표기로 본다(Obsidian 호환 규칙).
        const after = cx.char(pos + 1);
        if (after === 32 || after === 10 || after === 9 || after === -1) return -1;
        for (let i = pos + 1; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10) break; // 인라인 수식은 줄을 넘지 않는다
          if (c === BACKSLASH) {
            i++; // 이스케이프된 문자 건너뛰기
            continue;
          }
          if (c === DOLLAR) {
            // 닫는 $ 뒤가 숫자면 화폐($5 등)로 치고 무시한다.
            if (i + 1 < cx.end) {
              const n = cx.char(i + 1);
              if (n >= 48 && n <= 57) continue;
            }
            return cx.addElement(cx.elt("InlineMath", pos, i + 1));
          }
        }
        return -1;
      },
    },
  ],
  parseBlock: [
    {
      name: "mathBlock",
      before: "HorizontalRule",
      parse(cx, line) {
        const text = line.text.slice(line.pos);
        if (!text.startsWith("$$")) return false;
        const from = cx.lineStart + line.pos;
        // 같은 줄에서 닫히는 한 줄 수식: $$…$$
        if (text.length > 4 && text.endsWith("$$")) {
          cx.nextLine();
          cx.addElement(cx.elt("MathBlock", from, from + text.length));
          return true;
        }
        // 여러 줄: 닫는 $$ 줄이 나올 때까지 소비한다.
        // eager leaf 파서 규칙(§BlockParser.parse): 블록이 끝난 시점에서
        // 현재 줄은 블록 **뒤**의 줄이어야 한다 — 닫는 줄을 찾으면 한 번 더
        // nextLine()로 지나간다(lezer 자체 FencedCode와 동일한 소비 규칙).
        // 이 규칙을 어기면 닫는 줄 뒤의 문서가 통째로 트리에서 사라진다.
        let end = cx.lineStart + line.text.length;
        let closed = false;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          const t = line.text.slice(line.pos);
          if (t.trim() === "$$" || t.trim().startsWith("$$")) {
            closed = true;
            cx.nextLine();
            break;
          }
        }
        if (!closed) {
          // 닫는 $$ 없음 — 문서 끝까지를 수식 블록으로 본다(관대한 해석).
        }
        cx.addElement(cx.elt("MathBlock", from, end));
        return true;
      },
    },
  ],
};

/** DOCX 경로용 ==하이라이트== 강등 — comrak이 모르는 문법을 굵게로.
 *  (HTML·PDF는 <mark>로 그대로, DOCX만 이 변환을 쓴다.) 순수 함수. */
export function highlightToBold(text: string): string {
  return text.replace(/==([^=\n]+)==/g, "**$1**");
}
