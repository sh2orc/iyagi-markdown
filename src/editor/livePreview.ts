// 라이브 프리뷰 장식(§4-1). 구문 트리는 표시용 읽기 전용 정보로만 쓰고,
// 장식은 뷰포트 범위에서만 계산한다(§7 — 큰 문서 대응).
//
// 커서/선택/IME 조합 중인 블록은 장식을 풀어 원문을 보여 준다(Obsidian 방식).
// 읽기 모드는 같은 장식을 항상 켠다.

import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { EditorState, Facet, Range, StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

import { lexicallyClean, percentDecode } from "../links";
import {
  DiagramWidget,
  HRuleWidget,
  ImageWidget,
  MathWidget,
  SpacerWidget,
  TableWidget,
  TaskItemWidget,
} from "./widgets";

// — 설정 전달(문서 경로·이미지 정책·테마) —

export interface PreviewConfig {
  baseDir: string;
  remoteImages: boolean;
  showImages: boolean;
  theme: "light" | "dark";
}

export const setPreviewConfig = StateEffect.define<PreviewConfig>();

export const previewConfigField = StateField.define<PreviewConfig>({
  create: () => ({
    baseDir: "",
    remoteImages: true,
    showImages: true,
    theme: "light",
  }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setPreviewConfig)) value = e.value;
    }
    return value;
  },
});

// — 모드: 읽기(항상 렌더) vs 편집(커서 줄 원문 노출) —

export type PreviewBehavior = "render" | "reveal";
export const previewBehavior = Facet.define<PreviewBehavior, PreviewBehavior>({
  combine: (values) => values[0] ?? "reveal",
});

// — 장식 상태 필드 —
// 블록 장식(표·수식·다이어그램 위젯처럼 줄 높이를 바꾸는 것)은 ViewPlugin이
// 아니라 StateField에서 제공해야 한다(CM6 규칙). 플러그인은 계산만 하고
// 이펙트로 필드에 반영한다.

const setDecorations = StateEffect.define<DecorationSet>();

const decorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDecorations)) return e.value;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const plugin = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      // 뷰 구축 중에는 dispatch할 수 없으므로 초기 장식은 직후 마이크로태스크로.
      queueMicrotask(() => {
        this.buildIfAlive(view);
      });
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        u.focusChanged ||
        u.transactions.some((tr) => tr.effects.some((e) => e.is(setPreviewConfig)))
      ) {
        this.build(u.view);
      }
    }
    buildIfAlive(view: EditorView) {
      // destroy된 뷰는 dom이 떨어져 나간다(destroyed는 private이라 간접 확인).
      if (view.dom.isConnected) this.build(view);
    }

    build(view: EditorView) {
      // 구문 트리가 아직 범위를 덮지 못했으면(비동기 파싱 진행 중) 완료 후 재시도.
      const upto = view.viewport.to > view.viewport.from
        ? view.viewport.to
        : Math.min(view.state.doc.length, 50_000);
      if (!syntaxTreeAvailable(view.state, upto)) {
        setTimeout(() => this.buildIfAlive(view), 50);
        return;
      }
      // 항상 dispatch한다 — 이 dispatch는 doc/선택/뷰포트를 바꾸지 않으므로
      // 재귀 빌드가 일어나지 않는다.
      view.dispatch({ effects: setDecorations.of(buildDecorations(view)) });
    }
  },
);

export function livePreviewExtension(): Extension {
  return [decorationField, plugin];
}

// — 장식 빌더 —

const replace = Decoration.replace;

function buildDecorations(view: EditorView): DecorationSet {
  const behavior = view.state.facet(previewBehavior);
  const ranges: Range<Decoration>[] = [];
  const doc = view.state.doc;
  const { baseDir, remoteImages, showImages, theme } = view.state.field(previewConfigField);

  // 노출할 줄 = 편집 모드에서 커서·선택(·조합)이 걸친 줄.
  const revealed: number[] = [];
  if (behavior === "reveal") {
    const sel = view.state.selection;
    for (const range of sel.ranges) {
      const from = doc.lineAt(range.from).number;
      const to = doc.lineAt(range.to).number;
      for (let n = from; n <= to; n++) revealed.push(n);
    }
    if (view.composing && sel.main.head === sel.main.to) {
      // 조합 중 — 캐럿 줄 확실히 노출.
      revealed.push(doc.lineAt(sel.main.head).number);
    }
  }
  const isRevealed = (from: number, to: number): boolean => {
    if (revealed.length === 0) return false;
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    return revealed.some((n) => n >= first && n <= last);
  };

  const addLineClasses = (from: number, to: number, cls: string, skipFirst = false) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) {
      if (skipFirst && n === first) continue;
      const line = doc.line(n);
      ranges.push(Decoration.line({ class: cls }).range(line.from));
    }
  };

  const absPath = (src: string): string => {
    if (/^(https?:|data:|file:|#)/i.test(src)) return src;
    const decoded = percentDecode(src).replace(/\\/g, "/");
    if (decoded.startsWith("/")) return lexicallyClean(decoded);
    return lexicallyClean(`${baseDir}/${decoded}`);
  };

  const src = view.state.doc.toString();

  try {
    // 뷰포트 범위만 계산한다(§7). 측정 전(jsdom·첫 프레임) 뷰포트가 비어 있으면
    // 문서 전체를 한 번 본다 — 실제 앱에서는 곧바로 실측 뷰포트로 좁혀진다.
    const scanTo =
      view.viewport.to > view.viewport.from
        ? view.viewport.to
        : Math.min(doc.length, 50_000);
    syntaxTree(view.state).iterate({
      from: view.viewport.from,
      to: scanTo,
      enter: (ref) => {
        const node = ref.node;
        const name = node.name;
        const from = node.from;
        const to = node.to;

        // — 제목 —
        const heading = /^(ATX|Setext)Heading([1-6])$/.exec(name);
        if (heading) {
          const level = heading[2];
          addLineClasses(from, to, `md-h${level}`);
          if (heading[1] === "ATX") {
            const mark = node.firstChild;
            if (mark && mark.name === "HeaderMark") {
              // #들과 그 뒤 공백 하나까지 지운다.
              const hideTo = Math.min(
                mark.to + 1 <= to && src.slice(mark.to, mark.to + 1) === " " ? mark.to + 1 : mark.to,
                to,
              );
              if (!isRevealed(from, to)) {
                ranges.push(replace({}).range(mark.from, hideTo));
              }
            }
          } else {
            // Setext: 밑줄(===/---) 줄을 접는다.
            if (!isRevealed(from, to)) {
              const lastLine = doc.lineAt(to);
              if (lastLine.from > from) {
                ranges.push(replace({}).range(lastLine.from, to));
                ranges.push(Decoration.line({ class: "md-setext-underline" }).range(lastLine.from));
              }
            }
          }
          return;
        }

        // — 강조 —
        if (name === "Emphasis" || name === "StrongEmphasis") {
          if (isRevealed(from, to)) return;
          const cls = name === "StrongEmphasis" ? "md-strong" : "md-em";
          let contentFrom = from;
          let contentTo = to;
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === "EmphasisMark" || child.name === "StrongEmphasisMark") {
              ranges.push(replace({}).range(child.from, child.to));
            }
          }
          const first = node.firstChild;
          const last = node.lastChild;
          if (first && first.name.endsWith("Mark")) contentFrom = first.to;
          if (last && last.name.endsWith("Mark")) contentTo = last.from;
          if (contentTo > contentFrom) {
            ranges.push(Decoration.mark({ class: cls }).range(contentFrom, contentTo));
          }
          return;
        }

        // — 취소선 —
        if (name === "Strikethrough") {
          if (isRevealed(from, to)) return;
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === "StrikethroughMark") {
              ranges.push(replace({}).range(child.from, child.to));
            }
          }
          const first = node.firstChild;
          const last = node.lastChild;
          const cFrom = first && first.name === "StrikethroughMark" ? first.to : from;
          const cTo = last && last.name === "StrikethroughMark" ? last.from : to;
          if (cTo > cFrom) {
            ranges.push(Decoration.mark({ class: "md-strike" }).range(cFrom, cTo));
          }
          return;
        }

        // — 인라인 코드 —
        if (name === "InlineCode") {
          if (isRevealed(from, to)) return;
          for (let child = node.firstChild; child; child = child.nextSibling) {
            if (child.name === "CodeMark") ranges.push(replace({}).range(child.from, child.to));
          }
          const first = node.firstChild;
          const last = node.lastChild;
          const cFrom = first && first.name === "CodeMark" ? first.to : from;
          const cTo = last && last.name === "CodeMark" ? last.from : to;
          if (cTo > cFrom) {
            ranges.push(Decoration.mark({ class: "md-codeinline" }).range(cFrom, cTo));
          }
          return;
        }

        // — 링크·이미지(원문 정규식 기반 — 자식 구조 규격에 의존하지 않는다) —
        if (name === "Link" || name === "Image") {
          if (isRevealed(from, to)) return;
          const text = src.slice(from, to);
          if (name === "Image") {
            const m = /^!\[([^\]]*)\]\(\s*<?([^)>]*?)>?((?:\s+"[^"]*")?)\s*\)$/.exec(text);
            if (m) {
              const src2 = absPath(m[2].trim());
              const w: WidgetType = new ImageWidget(src2, m[1], m[3]?.trim().replace(/^"|"$/g, "") || null, { remoteImages, showImages });
              ranges.push(replace({ widget: w, block: false }).range(from, to));
            }
            return;
          }
          const inline = /^\[([\s\S]*)\]\(\s*<?([^)>]*?)>?((?:\s+"[^"]*")?)\s*\)$/.exec(text);
          if (inline) {
            // 여는 "["와 닫는 "](url)"을 지우고 라벨만 링크처럼 보이게.
            const labelEnd = from + 1 + inline[1].length;
            ranges.push(replace({}).range(from, from + 1));
            ranges.push(replace({}).range(labelEnd, to));
            if (labelEnd > from + 1) {
              ranges.push(Decoration.mark({ class: "md-link", attributes: { title: inline[2] } }).range(from + 1, labelEnd));
            }
            return;
          }
          // 참조 링크 [label][ref] — 라벨만 남긴다.
          const ref = /^\[([\s\S]*)\]\[([^\]]*)\]$/.exec(text);
          if (ref) {
            const labelEnd = from + 1 + ref[1].length;
            ranges.push(replace({}).range(from, from + 1));
            ranges.push(replace({}).range(labelEnd, to));
            ranges.push(Decoration.mark({ class: "md-link-ref" }).range(from + 1, labelEnd));
          }
          return;
        }

        // — URL·자동 링크 —
        if (name === "URL" || name === "Autolink") {
          ranges.push(Decoration.mark({ class: "md-url" }).range(from, to));
          return;
        }

        // — 코드 블록 —
        if (name === "FencedCode") {
          addLineClasses(from, to, "md-codeblock");
          if (isRevealed(from, to)) return;
          const first = node.firstChild;
          const info = first && first.name === "HeaderMark"
            ? src.slice(first.from, first.to).replace(/^[`~]+/, "").trim()
            : "";
          if (info === "mermaid") {
            const code = extractFenceBody(src, from, to);
            ranges.push(
              replace({ widget: new DiagramWidget(code, theme), block: true }).range(from, to),
            );
            return;
          }
          // 펜스 줄은 얇게 접는다.
          const firstLine = doc.lineAt(from);
          const lastLine = doc.lineAt(to);
          ranges.push(replace({ widget: new SpacerWidget(4) }).range(firstLine.from, firstLine.to));
          const lastTrim = lastLine.text.trim();
          if (
            lastLine.from > firstLine.from &&
            (lastTrim.startsWith("```") || lastTrim.startsWith("~~~"))
          ) {
            ranges.push(replace({ widget: new SpacerWidget(10) }).range(lastLine.from, lastLine.to));
          }
          return;
        }
        if (name === "CodeBlock") {
          addLineClasses(from, to, "md-codeblock md-codeblock-indented");
          return;
        }

        // — 인용 —
        if (name === "Blockquote") {
          addLineClasses(from, to, "md-quote");
          return;
        }
        if (name === "QuoteMark") {
          if (!isRevealed(from, to)) ranges.push(replace({ class: "md-quotemark" }).range(from, to));
          return;
        }

        // — 목록 —
        if (name === "ListMark") {
          ranges.push(Decoration.mark({ class: "md-listmark" }).range(from, to));
          return;
        }
        if (name === "TaskMarker") {
          if (isRevealed(from, to)) return;
          const checked = src.slice(from, to).charCodeAt(1) === 120; // x
          ranges.push(
            replace({ widget: new TaskItemWidget(checked) }).range(from, to),
          );
          return;
        }

        // — 표(GFM) —
        if (name === "Table") {
          if (isRevealed(from, to)) return;
          ranges.push(
            replace({ widget: new TableWidget(src.slice(from, to)), block: true }).range(from, to),
          );
          return;
        }

        // — 수평선 —
        if (name === "HorizontalRule") {
          if (isRevealed(from, to)) return;
          ranges.push(replace({ widget: new HRuleWidget(), block: true }).range(from, to));
          return;
        }

        // — 수식(커스텀 문법) —
        if (name === "MathBlock") {
          if (isRevealed(from, to)) return;
          const latex = src.slice(from, to).replace(/^\$\$/, "").replace(/\$\$$/, "");
          ranges.push(
            replace({ widget: new MathWidget(latex, true), block: true }).range(from, to),
          );
          return;
        }
        if (name === "InlineMath") {
          if (isRevealed(from, to)) return;
          const latex = src.slice(from + 1, to - 1);
          ranges.push(replace({ widget: new MathWidget(latex, false) }).range(from, to));
          return;
        }

        // — HTML 조각: 원문 유지, 회색 표시만(§4-2 3항) —
        if (name === "HTMLBlock" || name === "HTMLTag") {
          ranges.push(Decoration.mark({ class: "md-html" }).range(from, to));
          return;
        }
      },
    });
  } catch (e) {
    // 장식 실패는 표시를 원문으로 되돌릴 뿐 앱을 죽이지 않는다.
    console.error("livePreview 장식 실패", e);
  }

  return Decoration.set(ranges, true);
}

/** 펜스 코드 블록의 본문(펜스 줄 제외)을 뽑는다. */
function extractFenceBody(src: string, from: number, to: number): string {
  let s = src.slice(from, to);
  s = s.replace(/^[`~]+[^\n]*\n?/, "");
  s = s.replace(/\n?[`~]+$/, "");
  return s;
}

/** 클릭 위치의 링크 정보(내부 열기/외부 열기 분류는 links.ts가). */
export function findLinkAt(
  state: EditorState,
  pos: number,
): { url: string; from: number; to: number } | null {
  const src = state.doc.toString();
  let found: { url: string; from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: Math.max(0, pos - 2000),
    to: Math.min(src.length, pos + 2000),
    enter: (node) => {
      if (found) return false;
      if (node.name === "Link" && pos >= node.from && pos <= node.to) {
        const text = src.slice(node.from, node.to);
        const m = /^\[([\s\S]*)\]\(\s*<?([^)>]*?)>?\s*\)$/.exec(text);
        if (m) {
          found = { url: m[2], from: node.from, to: node.to };
          return false;
        }
      }
      return;
    },
  });
  return found;
}
