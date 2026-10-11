// $…$ 인라인 수식과 $$…$$ 블록 수식을 lezer-markdown에 추가하는 확장.
// 문법 요소만 만들고 표시는 livePreview 장식이 맡는다.

import { MarkdownExtension } from "@lezer/markdown";

const DOLLAR = 36;
const BACKSLASH = 92;

export const mathSyntax: MarkdownExtension = {
  defineNodes: [
    { name: "InlineMath" },
    { name: "MathBlock", block: true },
  ],
  parseInline: [
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
        let closed = false;
        let end = cx.lineStart + line.text.length;
        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length;
          const t = line.text.slice(line.pos);
          if (t.trim() === "$$" || t.trim().startsWith("$$")) {
            closed = true;
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
