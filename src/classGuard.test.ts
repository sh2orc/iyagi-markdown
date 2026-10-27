// CSS 클래스 네임스페이스 가드 — CodeMirror 내장 클래스(.cm-*)와의 충돌을
// 막는다(2026-10-13 버그: 메모 패널 .cm-line이 편집기 전체를 right-align).
// 규칙: styles.css의 .cm-* 선택자는 CodeMirror 실제 내장 이름만 허용(오버라이드),
// 컴포넌트 className은 cm- 접두 사용 금지(패널은 cmt- 등 다른 접두 사용).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "styles.css");

/** CodeMirror 6이 실제로 쓰는 내장 클래스(오버라이드 허용 목록). */
const CM_BUILTINS = new Set([
  "cm-editor",
  "cm-scroller",
  "cm-content",
  "cm-line",
  "cm-lines",
  "cm-gutters",
  "cm-gutter",
  "cm-lineNumbers",
  "cm-foldGutter",
  "cm-activeLine",
  "cm-activeLineGutter",
  "cm-selectionBackground",
  "cm-selection",
  "cm-cursor",
  "cm-cursors",
  "cm-focused",
  "cm-tooltip",
  "cm-tooltip-autocomplete",
  "cm-panels",
  "cm-searchMatch",
  "cm-placeholder",
  "cm-specialChar",
  "cm-tab",
  "cm-trailingSpace",
  "cm-foldPlaceholder",
  "cm-completionDetail",
  "cm-completionLabel",
  "cm-completionMatchedText",
  // 에디터 모듈이 CM 콘텐츠에 다는 자체 cm-* 장식(충돌 없는 고유 이름).
  "cm-focus-dim",
]);

function cmClassesIn(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/\.(cm-[a-zA-Z][\w-]*)/g)) out.add(m[1]!);
  return out;
}

describe("CodeMirror 클래스 충돌 가드", () => {
  it("styles.css의 .cm-* 선택자는 내장 이름만(자체 발명 cm-* 금지)", () => {
    const found = cmClassesIn(readFileSync(cssPath, "utf-8"));
    const unknown = [...found].filter((c) => !CM_BUILTINS.has(c));
    expect(unknown).toEqual([]);
  });

  it("컴포넌트 className에 cm- 접두 사용 금지(패널은 cmt- 등 사용)", () => {
    const dir = join(here, "components");
    const files = ["CommentsPanel.tsx", "VersionsPanel.tsx", "StatsPanel.tsx"];
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf-8");
      for (const m of src.matchAll(/className=\{?[`"]([^`"}]*)/g)) {
        for (const c of (m[1] ?? "").split(/\s+/)) {
          if (c.startsWith("cm-")) bad.push(`${f}: ${c}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("빈 줄 높이 규칙 가드", () => {
  it(".md-blank은 높이 속성을 가져선 안 된다(병합 되돌림 방지)", async () => {
    const { editorTheme } = await import("./editor/theme");
    // EditorView.theme은 모듈 평가 시 객체를 받는다 — 근원 텍스트 검사가
    // 더 확실하다: theme.ts에서 .md-blank 블록 직후 '}' 앞에 속성이 없는지.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "editor/theme.ts"),
      "utf-8",
    );
    const m = /"\.md-blank":\s*\{([^}]*)\}/.exec(src);
    expect(m).not.toBeNull();
    const body = (m?.[1] ?? "").trim();
    expect(body).toBe(""); // 어떤 높이 오버라이드도 금지
    void editorTheme;
  });
});
