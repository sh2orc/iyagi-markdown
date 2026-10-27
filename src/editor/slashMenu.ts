// / 메뉴 — Notion식 블록 삽입. 줄 처음(또는 공백 뒤)에서 "/"를 입력하면
// 삽입 항목 메뉴가 뜨고 이어 치는 글자로 거른다(한글·영어 모두). 적용은
// "/질의" 구간을 지우고 항목을 적용한다. 원문은 표준 마크다운만(§4-1).

import { enclosingNode, literalCompletionNodes, linkCompletionNodes } from "./completionContext";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { isolateHistory } from "@codemirror/commands";

import { blockInsertionText, insertPageBreak, insertToc, tableMarkdown } from "./format";

/** 항목 적용기 — from..to는 "/질의" 구간. */
export type SlashApply = (view: EditorView, from: number, to: number) => void;

export type SlashSection = "block" | "insert" | "doc";

/** 섹션(Notion의 그룹 머리) — rank 순서로 패널에 묶인다. */
const SECTION_DEFS: Record<SlashSection, { name: string; rank: number }> = {
  block: { name: "기본 블록", rank: 1 },
  insert: { name: "삽입", rank: 2 },
  doc: { name: "문서 구조", rank: 3 },
};

export interface SlashItem {
  id: string;
  /** 한국어 라벨(표시·한글 검색). */
  ko: string;
  /** 영어 라벨(검색 별칭). */
  en: string;
  /** 부제 — 항목 아래 한 줄 설명. */
  sub: string;
  /** 아이콘 글리프(아이콘 칸에 표시). */
  icon: string;
  section: SlashSection;
  apply: SlashApply;
}

/** 줄머리 변형(/h1 → "# ") — 질의를 지우고 줄 처음에 접두를 붙인다.
 *  커서는 접두 바로 뒤(Notion과 같이 이어 바로 작성). */
function linePrefix(prefix: string): SlashApply {
  return (view, from, to) => {
    if (view.state.readOnly) return;
    const line = view.state.doc.lineAt(from);
    view.dispatch({
      changes: [{ from, to }, { from: line.from, insert: prefix }],
      selection: { anchor: line.from + prefix.length },
      annotations: isolateHistory.of("full"), userEvent: "input.slash",
    });
  };
}

/** 블록 템플릿 — 질의를 템플릿으로 바꾸고 커서를 offset 자리에. */
function block(template: string, cursorOffset?: number): SlashApply {
  return (view, from, to) => {
    if (view.state.readOnly) return;
    view.dispatch({
      changes: { from, to, insert: template },
      selection: { anchor: from + (cursorOffset ?? template.length) },
      annotations: isolateHistory.of("full"), userEvent: "input.slash",
    });
  };
}

/** Pass the command range directly so deletion and insertion are one edit. */
function viaHelper(helper: (view: EditorView, range: { from: number; to: number }) => boolean): SlashApply {
  return (view, from, to) => {
    helper(view, { from, to });
  };
}

/** / 메뉴 항목 — 추가 항목은 이 배열에만(자동으로 검색·적용에 끼운다). */
export const SLASH_ITEMS: SlashItem[] = [
  { id: "h1", ko: "제목 1", en: "heading 1", sub: "가장 큰 섹션 제목", icon: "H1", section: "block", apply: linePrefix("# ") },
  { id: "h2", ko: "제목 2", en: "heading 2", sub: "중간 섹션 제목", icon: "H2", section: "block", apply: linePrefix("## ") },
  { id: "h3", ko: "제목 3", en: "heading 3", sub: "작은 섹션 제목", icon: "H3", section: "block", apply: linePrefix("### ") },
  { id: "bullet", ko: "글머리 목록", en: "bullet list", sub: "순서 없는 목록", icon: "•", section: "block", apply: linePrefix("- ") },
  { id: "list", ko: "번호 목록", en: "numbered list", sub: "순서 있는 목록", icon: "1.", section: "block", apply: linePrefix("1. ") },
  { id: "task", ko: "할 일", en: "to-do", sub: "체크박스 목록", icon: "☑", section: "block", apply: linePrefix("- [ ] ") },
  { id: "quote", ko: "인용", en: "quote", sub: "인용문 블록", icon: "❝", section: "block", apply: linePrefix("> ") },
  { id: "code", ko: "코드 블록", en: "code block", sub: "구문 강조 코드", icon: "</>", section: "block", apply: block("```\n\n```", 4) },
  { id: "table", ko: "표", en: "table", sub: "행×열 표(셀 클릭 편집)", icon: "▦", section: "insert", apply: block(blockInsertionText(tableMarkdown(3, 3))) },
  { id: "math", ko: "수식 블록", en: "math block", sub: "LaTeX 수식", icon: "∑", section: "insert", apply: block("$$\n\n$$", 3) },
  { id: "image", ko: "이미지", en: "image", sub: "이미지 삽입", icon: "▣", section: "insert", apply: block("![]()", 2) },
  { id: "link", ko: "링크", en: "link", sub: "하이퍼링크", icon: "↗", section: "insert", apply: block("[](url)", 2) },
  { id: "hr", ko: "수평선", en: "horizontal rule", sub: "구분선", icon: "―", section: "doc", apply: block("---") },
  { id: "pagebreak", ko: "페이지 나누기", en: "page break", sub: "쪽나눔(\\newpage)", icon: "↧", section: "doc", apply: viaHelper(insertPageBreak) },
  { id: "toc", ko: "목차", en: "table of contents", sub: "제목 목차 생성", icon: "☰", section: "doc", apply: viaHelper(insertToc) },
];

/** Literal or structured syntax where slash commands would corrupt the content. */
const protectedNodes = new Set([
  ...literalCompletionNodes, ...linkCompletionNodes, "CodeText", "WikiLink", "FootnoteDef",
]);
function inCodeLike(state: CompletionContext["state"], pos: number): boolean {
  return enclosingNode(state, pos, protectedNodes) !== null;
}

/** "/" 뒤 질의(한글·영문·숫자·_-). 슬래시는 줄 처음 또는 공백 뒤여야
 *  한다(URL·경로·한글 붙여쓰기 "남자/여자"는 메뉴를 열지 않는다). */
const SLASH_BEFORE = /(?:^|\s)\/([\p{L}\p{N}_-]*)$/u;

/** CM Completion에 얹는 / 메뉴 전용 필드 — addToOptions 렌더러가 읽는다. */
export type SlashCompletion = Completion & {
  slashIcon?: string;
  slashSub?: string;
};

export function slashCompletions(context: CompletionContext): CompletionResult | null {
  if (context.state.readOnly || inCodeLike(context.state, context.pos)) return null;
  const line = context.state.doc.lineAt(context.pos);
  const m = SLASH_BEFORE.exec(line.text.slice(0, context.pos - line.from));
  if (!m) return null;
  const query = m[1]!;
  // Include the slash in the replacement range. With custom filtering there is
  // no label-matching penalty, and backspacing the query to "/" stays active.
  const from = context.pos - query.length - 1;
  const q = query.toLowerCase();
  const options: Completion[] = SLASH_ITEMS.filter(
    (it) =>
      !q ||
      it.ko.toLowerCase().includes(q) ||
      it.en.toLowerCase().includes(q) ||
      it.id.includes(q),
  ).map(
    (it) =>
      ({
        label: it.ko,
        type: "keyword",
        slashIcon: it.icon,
        slashSub: it.sub,
        section: SECTION_DEFS[it.section],
        // The completion and command both use the full slash-command range.
        apply: (view: EditorView, _c: Completion, f: number, t: number) => {
          if (view.state.readOnly || f < 0 || t <= f || t > view.state.doc.length || inCodeLike(view.state, t)) return;
          const line = view.state.doc.lineAt(t);
          const match = SLASH_BEFORE.exec(line.text.slice(0, t - line.from));
          if (!match || t - match[1].length - 1 !== f) return;
          it.apply(view, f, t);
        },
      }) as SlashCompletion,
  );
  if (options.length === 0) return null;
  // Alias matching already happened above. Filtering Korean labels again drops
  // English/id matches; caching a narrowed list also loses options on backspace.
  return { from, options, filter: false,
    update: (_result, _from, _to, nextContext) => slashCompletions(nextContext),
  };
}
