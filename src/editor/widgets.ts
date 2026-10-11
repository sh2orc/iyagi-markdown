// 라이브 프리뷰 위젯 — 장식이 대체한 마크다운 구문 대신 그려지는 DOM.
// 모든 위젯은 원문을 수정하지 않는 표시물일 뿐이고, 상호작용(체크박스 등)은
// 원문 텍스트 편집으로 번역된다(§4-1).

import { EditorView, WidgetType } from "@codemirror/view";

import { convertFileSrc, isInApp } from "../api";
import { renderMathInto } from "../plugins/katex";
import { renderMermaid } from "../plugins/mermaid";

// — 수식 —

export class MathWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly display: boolean,
  ) {
    super();
  }

  eq(other: MathWidget) {
    return other.latex === this.latex && other.display === this.display;
  }

  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "md-math md-math-block" : "md-math md-math-inline";
    renderMathInto(el, this.latex, this.display);
    return el;
  }

  ignoreEvent() {
    return true; // 수식 영역 클릭이 커서 이동을 방해하지 않게
  }
}

// — mermaid 다이어그램 —

export class DiagramWidget extends WidgetType {
  #theme: "light" | "dark";
  constructor(
    readonly code: string,
    theme: "light" | "dark",
  ) {
    super();
    this.#theme = theme;
  }

  eq(other: DiagramWidget) {
    return other.code === this.code && other.#theme === this.#theme;
  }

  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "md-diagram";
    wrap.dataset.pending = "1";
    void renderMermaid(this.code, this.#theme).then(({ svg, error }) => {
      delete wrap.dataset.pending;
      if (svg) {
        wrap.innerHTML = svg;
        const svgEl = wrap.firstElementChild;
        if (svgEl instanceof SVGSVGElement) {
          svgEl.removeAttribute("height");
          svgEl.style.maxWidth = "100%";
        }
      } else {
        wrap.classList.add("md-diagram-error");
        const code = document.createElement("pre");
        code.textContent = this.code;
        const msg = document.createElement("div");
        msg.className = "md-diagram-error-msg";
        msg.textContent = error ?? "render failed";
        wrap.append(msg, code);
      }
    });
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

// — 이미지 —

export interface ImageWidgetOpts {
  remoteImages: boolean;
  showImages: boolean;
}

export class ImageWidget extends WidgetType {
  #url: string;
  #broken = false;
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly title: string | null,
    readonly opts: ImageWidgetOpts,
  ) {
    super();
    const isRemote = /^https?:\/\//i.test(src);
    this.#url = !isRemote && isInApp() ? convertFileSrc(src) : src;
    this.#broken = !isRemote && !isInApp();
  }

  eq(other: ImageWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.title === this.title &&
      other.opts.remoteImages === this.opts.remoteImages &&
      other.opts.showImages === this.opts.showImages
    );
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "md-image";
    if (!this.opts.showImages) {
      wrap.classList.add("md-image-off");
      wrap.textContent = `🖼 ${this.alt || this.src}`;
      return wrap;
    }
    if (this.#broken) {
      wrap.classList.add("md-image-missing");
      wrap.textContent = this.alt || this.src;
      wrap.title = this.alt;
      return wrap;
    }
    const remote = /^https?:\/\//i.test(this.src);
    if (remote && !this.opts.remoteImages) {
      wrap.classList.add("md-image-blocked");
      wrap.textContent = `🚫 ${this.alt || this.src}`;
      wrap.title = this.src;
      wrap.addEventListener("mousedown", (e) => {
        // 클릭 시 이 이미지만 허용 목록에 올린 뒤 다시 그린다 — 상태는 전역 설정이
        // 아니라 이 위젯 인스턴스에만 적용된다(§4-6: 클릭 시 해당 이미지만 로드).
        e.preventDefault();
        const unlocked = new ImageWidget(this.src, this.alt, this.title, {
          ...this.opts,
          remoteImages: true,
        });
        wrap.replaceWith(unlocked.toDOM(view));
      }, { once: true });
      return wrap;
    }
    const img = document.createElement("img");
    img.src = this.#url;
    if (this.alt) img.alt = this.alt;
    if (this.title) img.title = this.title;
    img.draggable = false;
    let retried = false;
    img.addEventListener("error", () => {
      // 문서 폴더 바깥 상대 경로(../…)는 asset 범위에 없어 실패한다 —
      // 그 이미지의 폴더만 허용받아 한 번 재시도하고, 그래도 안 되면 대체 텍스트.
      if (!retried && !/^https?:/i.test(this.src) && isInApp()) {
        retried = true;
        void grantAndRetry(img, this.src);
        return;
      }
      wrap.classList.add("md-image-missing");
      img.replaceWith(document.createTextNode(this.alt || this.src));
    });
    img.addEventListener("load", () => {
      if (img.naturalWidth > 0) {
        img.dataset.ratio = (img.naturalHeight / img.naturalWidth).toFixed(4);
      }
    });
    wrap.append(img);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

// — 표 —

export interface ParsedTable {
  align: ("left" | "center" | "right" | null)[];
  header: string[];
  rows: string[][];
}

/** GFM 표 원문 → 구조. 장식 빌더가 부른다(순수 함수 — 단위 테스트 대상). */
export function parseTable(src: string): ParsedTable | null {
  const lines = src.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const splitRow = (line: string): string[] => {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const cells: string[] = [];
    let cur = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === "\\" && s[i + 1] === "|") {
        cur += "|";
        i++;
      } else if (c === "|") {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += c;
      }
    }
    cells.push(cur.trim());
    return cells;
  };
  const sep = splitRow(lines[1]).map((c) => /^:?-{1,}:?$/.test(c.trim()) ? c.trim() : null);
  if (sep.length === 0 || sep.some((c) => c === null)) return null;
  const align = sep.map((c) => {
    if (!c) return null;
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
  const header = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  return { align, header, rows };
}

/** 이미지 경로의 폴더를 asset 범위에 추가하고 다시 불러온다(온디맨드 허용). */
async function grantAndRetry(img: HTMLImageElement, src: string): Promise<void> {
  try {
    const { api } = await import("../api");
    const dir = src.substring(0, src.lastIndexOf("/"));
    if (dir) await api.setAssetScope(dir, false);
    img.src = convertFileSrc(src);
  } catch {
    // 무시 — 두 번째 실패에서 대체 텍스트로 떨어진다.
  }
}

const tableCellText = (raw: string): DocumentFragment => {
  // 표 셀 안의 인라인 마크다운(굵게/기울임/코드)을 가볍게 렌더한다.
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (m.index > last) frag.append(raw.slice(last, m.index));
    const tok = m[0];
    let el: HTMLElement;
    if (tok.startsWith("**") || tok.startsWith("__")) {
      el = document.createElement("strong");
      el.textContent = tok.slice(2, -2);
    } else if (tok.startsWith("`")) {
      el = document.createElement("code");
      el.textContent = tok.slice(1, -1);
    } else {
      el = document.createElement("em");
      el.textContent = tok.slice(1, -1);
    }
    frag.append(el);
    last = m.index + tok.length;
  }
  if (last < raw.length) frag.append(raw.slice(last));
  return frag;
};

export class TableWidget extends WidgetType {
  constructor(readonly src: string) {
    super();
  }

  eq(other: TableWidget) {
    return other.src === this.src;
  }

  toDOM() {
    const parsed = parseTable(this.src) ?? { align: [], header: [], rows: [] };
    const wrap = document.createElement("div");
    wrap.className = "md-table-wrap";
    const table = document.createElement("table");
    table.className = "md-table";
    const thead = document.createElement("thead");
    const hrow = document.createElement("tr");
    parsed.header.forEach((cell, i) => {
      const th = document.createElement("th");
      const a = parsed.align[i];
      if (a) th.style.textAlign = a;
      th.append(tableCellText(cell));
      hrow.append(th);
    });
    thead.append(hrow);
    table.append(thead);
    const tbody = document.createElement("tbody");
    for (const row of parsed.rows) {
      const tr = document.createElement("tr");
      row.forEach((cell, i) => {
        const td = document.createElement("td");
        const a = parsed.align[i];
        if (a) td.style.textAlign = a;
        td.append(tableCellText(cell));
        tr.append(td);
      });
      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

// — 작업 목록 체크박스 —

export class TaskItemWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  eq(other: TaskItemWidget) {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "md-task";
    box.checked = this.checked;
    // 클릭은 cm.ts의 domEventHandlers가 원문 편집으로 번역한다(위치 역산 필요).
    box.addEventListener("mousedown", (e) => e.preventDefault());
    box.addEventListener("click", (e) => {
      e.preventDefault();
      // 위젯 시작 위치를 역산해 [ ]/[x] 토글.
      const pos = view.posAtDOM(box);
      toggleTaskAt(view, pos);
    });
    return box;
  }
}

/** pos 근처의 작업 표시([ ] 또는 [x])를 토글한다. */
export function toggleTaskAt(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/.exec(line.text);
  if (!m) return;
  const from = line.from + m[1].length;
  const to = from + 1;
  view.dispatch({
    changes: { from, to, insert: m[2] === " " ? "x" : " " },
    // 사용자 편집으로 취소 가능하게.
    userEvent: "input.taskToggle",
  });
}

// — 수평선 —

export class HRuleWidget extends WidgetType {
  eq() {
    return true;
  }

  toDOM() {
    const el = document.createElement("div");
    el.className = "md-hr";
    return el;
  }

  ignoreEvent() {
    return true;
  }
}

// — 펜스 줄 같은 얇은 자리 —

export class SpacerWidget extends WidgetType {
  constructor(readonly height: number) {
    super();
  }

  eq(other: SpacerWidget) {
    return other.height === this.height;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "md-spacer";
    el.style.height = `${this.height}px`;
    return el;
  }

  ignoreEvent() {
    return true;
  }
}
