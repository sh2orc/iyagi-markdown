// 스마트 문장부호(Word 자동 교정) — 입력한 글자를 문맥에 맞게 바꾼다.
// 변환은 커서 앞 몇 글자만 보는 순수 판정 + 한 번의 트랜잭션이므로
// 되돌리기 가능하고, 코드·수식·프런트매터·URL 안에서는 동작하지 않는다.

import { EditorView } from "@codemirror/view";
import { Compartment, Extension, Facet } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";

export const smartPunctComp = new Compartment();

/** 현재 켜짐 여부 — 같은 값의 재구성을 건너뛰는 기준. */
const smartPunctConf = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? false,
});

/** 커서 앞 상태로 닫는 따옴표인지 — 앞이 없거나 공백·여는 괄호·따옴표·
 *  대시류이면 여는 괄호. 순수 함수(테스트 대상). */
export function isCloseQuote(before: string): boolean {
  if (before === "") return false;
  return !/[\s([{"“‘–—]$/.test(before);
}

/** 입력 1글자 + 커서 앞 3글자로 대체 입력을 정한다. 순수 함수.
 *  atDashLine: 커서 줄의 커서 앞이 공백·대시류([-–—])뿐 — 수평선 ---
 *  을 입력하는 중이라 대시 변환을 하지 않는다(2026-10-21 보고 — 이 가드가
 *  없으면 세 번째 - 가 – 로 바뀌어 --- 이 절대 완성되지 않는다. 3글자
 *  미리보기 창으론 앞 줄이 있을 때 "\n--"를 줄 시작으로 못 알아봤다).
 *  반환: [교체 시작 오프셋(음수 = 커서에서 뒤로), 삽입 문자열] | null */
export function smartChar(
  ch: string,
  before: string,
  atDashLine = false,
): readonly [number, string] | null {
  switch (ch) {
    case '"':
      return [0, isCloseQuote(before) ? "”" : "“"];
    case "'":
      return [0, isCloseQuote(before) ? "’" : "‘"];
    case ".": {
      // ... → … (앞이 정확히 두 점이고 그 앞이 점이 아닐 때).
      if (before.endsWith("..") && before.slice(-3, -2) !== ".") return [-2, "…"];
      return null;
    }
    case "-": {
      // -- → – , –- → — (줄 시작·대시 연속 제외 — atDashLine이 정확한 판정)
      if (atDashLine) return null;
      if (before.endsWith("–") && before.slice(-2, -1) !== "-") return [-1, "—"];
      if (before.endsWith("--") && before.length > 2 && before.slice(-3, -2) !== "-") {
        return [-2, "–"];
      }
      return null;
    }
    default:
      return null;
  }
}

/** 변환하면 안 되는 문맥 — 코드·인라인 코드·수식·프런트매터·링크 URL. */
export function inRawContext(pos: number, tree: Tree): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, -1);
  while (node) {
    if (
      /^(FencedCode|CodeMark|CodeText|InlineCode|CodeInfo|Comment|FrontMatter|InlineMath|MathBlock|URL|LinkLabel|KatexRender)/.test(
        node.name,
      )
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

/** 입력 시 변환 확장 — 설정 배선은 applySmartPunct가 컴파트먼트로. */
export function smartPunctExtension(enabled: boolean): Extension {
  if (!enabled) return [smartPunctConf.of(false)];
  return [
    smartPunctConf.of(true),
    EditorView.inputHandler.of((view, from, to, text) => {
    if (text.length !== 1) return false;
    const before = view.state.doc.sliceString(Math.max(0, from - 3), from);
    // 커서 줄이 (공백·인용구 마커·)대시류로만 이뤄지면 수평선 입력 중 —
    // 대시 변환 금지. 인용구 안("> ---")도 포함(2026-10-24 검토 구멍).
    const line = view.state.doc.lineAt(from);
    const atDashLine = /^[\s–—>\-]*$/.test(view.state.doc.sliceString(line.from, from));
    const repl = smartChar(text, before, atDashLine);
    if (!repl) return false;
    if (inRawContext(from, syntaxTree(view.state))) return false;
    const [back, insert] = repl;
    view.dispatch({
      changes: { from: from + back, to, insert },
      selection: { anchor: from + back + insert.length },
      userEvent: "input.type",
    });
      return true;
    }),
  ];
}

/** 설정 적용 — 같은 값의 재구성은 건너뛴다(applyWriting과 같은 교훈). */
export function applySmartPunct(view: EditorView, enabled: boolean): void {
  if (view.state.facet(smartPunctConf) === enabled) return;
  view.dispatch({
    effects: smartPunctComp.reconfigure(smartPunctExtension(enabled)),
  });
}
