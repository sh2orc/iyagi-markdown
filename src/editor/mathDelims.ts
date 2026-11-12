// MathJax/LaTeX식 수식 구분자 — `\[ … \]`(블록)와 `\( … \)`(인라인).
// ChatGPT·Claude 등 LLM 출력과 LaTeX에서 옮긴 문서가 이 표기를 쓴다. 편집기는
// 문법 확장(mathSyntax)이 직접 읽고, 내보내기는 이 모듈로 `$$`/`$` 표기로 바꿔
// 기존 파이프라인(markdown-it·comrak)에 넘긴다. 순수 함수 — 파서를 끌어오지 않는다.

import { inRanges, literalRanges } from "./literalRanges";

/** 줄이 블록 수식을 닫는가 — `\]` 로 끝남(뒤 공백 허용). */
export function closesDisplayMath(line: string): boolean {
  return line.trimEnd().endsWith("\\]");
}

/** `\[ … \]` → `$$ … $$`, `\( … \)` → `$…$`. 코드 펜스·인라인 코드는 그대로.
 *  줄 수는 바뀌지 않는다(문서 메모·인용의 줄 번호가 내보내기에서 어긋나지 않게).
 *  블록은 `\[` 만 있는 줄에서 열려 `\]` 로 끝나는 줄에서 닫히거나, 한 줄
 *  `\[ … \]` 이다 — 문장 중간의 `\[글자\]`(대괄호 이스케이프)는 건드리지 않는다. */
export function normalizeMathDelimiters(text: string): string {
  if (!text.includes("\\[") && !text.includes("\\(")) return text;
  const literal = literalRanges(text);
  const lines = text.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    starts.push(pos);
    pos += line.length + 1;
  }
  const inline = (line: string, offset: number): string =>
    line.replace(/\\\((.+?)\\\)/g, (whole, inner: string, at: number) => {
      const latex = inner.trim();
      if (!latex || latex.includes("$") || inRanges(literal, offset + at)) return whole;
      return `$${latex}$`;
    });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inRanges(literal, starts[i]!)) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("\\[")) {
      const indent = line.slice(0, line.length - line.trimStart().length);
      // 한 줄 수식: \[ … \]
      if (trimmed.length > 4 && trimmed.endsWith("\\]")) {
        lines[i] = `${indent}$$${trimmed.slice(2, -2).trim()}$$`;
        continue;
      }
      if (trimmed === "\\[") {
        let close = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (closesDisplayMath(lines[j]!)) { close = j; break; }
        }
        if (close > 0) {
          lines[i] = `${indent}$$`;
          const end = lines[close]!.trimEnd();
          lines[close] = `${end.slice(0, -2)}$$`;
          i = close;
          continue;
        }
      }
    }
    lines[i] = inline(line, starts[i]!);
  }
  return lines.join("\n");
}
