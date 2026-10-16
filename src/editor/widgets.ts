// 라이브 프리뷰 위젯 — 장식이 대체한 마크다운 구문 대신 그려지는 DOM.
// 모든 위젯은 원문을 수정하지 않는 표시물일 뿐이고, 상호작용(체크박스 등)은
// 원문 텍스트 편집으로 번역된다(§4-1).

import { EditorState } from "@codemirror/state";
import { captionWorthy } from "./caption";
import { EditorView, WidgetType } from "@codemirror/view";

import { api, convertFileSrc, isInApp } from "../api";
import { renderMathInto } from "../plugins/katex";
import { renderMermaid } from "../plugins/mermaid";
import { parseFrontMatter } from "./frontmatter";
import { phrases } from "../app/phrases";
import * as tableOps from "./tableOps";
import type { CellRect } from "./tableOps";

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

  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "md-math md-math-block" : "md-math md-math-inline";
    // 첫 렌더는 프레임 예산 큐로 나뉘어 그려진다(캐시 히트는 즉시) — 수식이
    // 몰려 스크롤해도 동기 KaTeX 렌더가 스크롤 프레임을 뺏지 않게.
    renderMathInto(el, this.latex, this.display, () => {
      if (view.dom.isConnected) view.requestMeasure();
    });
    // 블록 수식 클릭 → 커서를 원문($$ 안)으로 — 커서 줄 노출이 원문을
    // 보여 즉석 편집(표 셀 클릭과 같은 '클릭=편집' 규칙, 104차).
    if (this.display) {
      el.addEventListener("mousedown", (e: Event) => {
        if ((e as MouseEvent).button !== 0) return;
        e.preventDefault();
        const pos = view.posAtDOM(el);
        const doc = view.state.doc;
        const line = doc.lineAt(pos);
        view.dispatch({ selection: { anchor: Math.min(pos + 2, line.to) }, scrollIntoView: true });
        view.focus();
      });
    }
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

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "md-diagram";
    wrap.dataset.pending = "1";
    void renderMermaid(this.code, this.#theme).then(({ svg, error }) => {
      if (!wrap.isConnected) return; // 뷰포트를 벗어나 이미 치워진 위젯
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
        msg.textContent = error ?? phrases.diagramError;
        wrap.append(msg, code);
      }
      // 높이가 확정되는 비동기 채움 뒤 재측정(뷰포트 계산이 갱신되게).
      if (view.dom.isConnected) view.requestMeasure();
    });
    // 클릭 → 커서를 펜스 코드로 — 원문 노출로 즉석 편집(클릭=편집, 104-105차 규칙).
    wrap.addEventListener("mousedown", (e: Event) => {
      if ((e as MouseEvent).button !== 0) return;
      e.preventDefault();
      const pos = view.posAtDOM(wrap);
      const doc = view.state.doc;
      const line = doc.lineAt(pos);
      // 펜스 시작 줄 다음(코드 첫 줄)으로.
      view.dispatch({
        selection: { anchor: Math.min(line.to + 1, doc.length) },
        scrollIntoView: true,
      });
      view.focus();
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
    readonly widthPct?: number,
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
      other.opts.showImages === this.opts.showImages &&
      other.widthPct === this.widthPct
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
      wrap.title = phrases.imgMissing;
      return wrap;
    }
    const remote = /^https?:\/\//i.test(this.src);
    if (remote && !this.opts.remoteImages) {
      wrap.classList.add("md-image-blocked");
      wrap.textContent = `🚫 ${this.alt || this.src}`;
      wrap.title = phrases.imgLoadBlocked;
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
    // 스크롤 부드러움: 삽입 시 동기 디코드를 피하고, 뷰포트에서 먼 이미지는
    // 가까이 올 때까지 내려받지 않는다(미지원 웹뷰는 무시하는 무해한 힌트).
    img.decoding = "async";
    img.loading = "lazy";
    if (this.widthPct) img.style.width = `${this.widthPct}%`;
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
    // 클릭 → 확대 뷰어(App이 등록한 콜백 — 원문 불변, 보기만).
    img.addEventListener("click", () => imageViewerHandler?.(this.src, this.alt));
    wrap.append(img);
    // alt가 비었거나 파일명 모양이면 호버 칩 '설명 추가' — 캡션·접근성
    // 진입점(63·108차 퍼널 확장: screenshot.png 같은 무의미 alt도 유도).
    const altIsFilename = /^(img|image|screenshot|screen|shot|pic|photo)?[\s_-]*[\w-]*\.(png|jpe?g|gif|webp|svg|bmp|heic|avif|tiff?)$/i.test(this.alt.trim());
    if ((!this.alt.trim() || altIsFilename) && imageCaptionHandler) {
      const chip = document.createElement("button");
      chip.className = "md-img-caption-add";
      chip.textContent = "＋ 설명";
      chip.title = "이미지 설명(대체 텍스트) 추가 — 캡션·접근성";
      chip.addEventListener("mousedown", (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        imageCaptionHandler!(this.src, view.posAtDOM(wrap));
      });
      wrap.append(chip);
    }
    // 캡션 후보 alt면 이미지 아래 설명 — 내보내기 figcaption과 같은 규칙.
    if (captionWorthy(this.alt)) {
      const cap = document.createElement("span");
      cap.className = "md-image-caption";
      cap.textContent = this.alt;
      wrap.append(cap);
    }
    // 크기 조절 핸들(편집 중에만) — 드래그로 폭(%)을 정하고 놓으면 문서
    // 스타일 사이드카에 저장한다. **원문은 전혀 수정되지 않는다.**
    const editable = view.state.facet(EditorState.readOnly).valueOf() !== true;
    if (editable) {
      const handle = document.createElement("span");
      handle.className = "md-img-handle";
      handle.title = "↔";
      let base = 0;
      let basePct = 0;
      let containerW = 0;
      let pendingPct = 0;
      let raf = 0;
      // 폭 쓰기는 rAF로 모은다 — pointermove마다 스타일을 쓰면 매 이벤트마다
      // 레이아웃이 잡히고(읽기-쓰기 스래시), 초당 120회 이벤트 장치에서 끊긴다.
      const applyPct = () => {
        raf = 0;
        if (pendingPct > 0) img.style.width = `${pendingPct}%`;
      };
      const onMove = (ev: PointerEvent) => {
        if (containerW <= 0) return;
        const pct = Math.round(Math.min(100, Math.max(10, basePct + ((ev.clientX - base) / containerW) * 100)));
        pendingPct = pct;
        handle.dataset.pct = String(pct);
        if (!raf) raf = requestAnimationFrame(applyPct);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
        applyPct(); // 마지막 값 즉시 반영 — 놓은 시점과 저장값이 일치하게
        const pct = Number(handle.dataset.pct ?? 0);
        if (pct > 0) imageResizeHandler?.(this.src, pct);
      };
      handle.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        base = ev.clientX;
        basePct = this.widthPct ?? 100;
        const host = wrap.closest(".editor-host, .cm-content");
        containerW = host?.clientWidth ?? wrap.clientWidth; // 드래그 중엔 다시 안 읽는다
        pendingPct = 0;
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
      wrap.append(handle);
    }
    return wrap;
  }

  ignoreEvent() {
    return true;
  }
}

/** 이미지 폭 저장 콜백 — App이 스토어와 연결한다(원문 불변 사이드카). */
export let imageResizeHandler: ((src: string, pct: number) => void) | null = null;

/** 이미지 클릭 → 확대 뷰어 콜백(App이 등록). */
export let imageViewerHandler: ((src: string, alt: string) => void) | null = null;

/** 표 헤더 클릭 → (열 인덱스, altKey 여부) 콜백(App이 등록). */
export let tableHeaderClickHandler: ((col: number, reset?: boolean) => void) | null = null;
export function setTableHeaderClickHandler(fn: ((col: number, reset?: boolean) => void) | null): void {
  tableHeaderClickHandler = fn;
}
export function setImageViewerHandler(fn: ((src: string, alt: string) => void) | null): void {
  imageViewerHandler = fn;
}
export function setImageResizeHandler(fn: ((src: string, pct: number) => void) | null): void {
  imageResizeHandler = fn;
}

// — 표 —

export interface ParsedTable {
  align: ("left" | "center" | "right" | null)[];
  header: string[];
  rows: string[][];
}


/** 렌더된 셀의 그리드 열 좌표 — 병합 고스트가 행에서 빠지므로 dataset 사용. */
function gridColOf(cell: HTMLElement, rowEl: HTMLElement): number {
  const g = cell.dataset.gridC;
  if (g != null) return Number(g);
  return Array.from(rowEl.children).indexOf(cell);
}

/** (행, 그리드 열) 셀 찾기 — dataset.gridC 일치(없으면 자식 인덱스 폴백). */
function gridCellAt(rows: Element[], r: number, c: number): HTMLElement | null {
  const tr = rows[r];
  if (!tr) return null;
  const byGrid = Array.from(tr.children).find(
    (el) => el instanceof HTMLElement && el.dataset.gridC === String(c),
  );
  return (byGrid instanceof HTMLElement ? byGrid : (tr.children[c] as HTMLElement | undefined)) ?? null;
}

// — 표 우클릭 메뉴 다리 — 위젯(표 안)에서 우클릭하면 ContextMenu가 표 전용
// 항목을 띄운다. 위젯은 구조 연산(tableOps)을 실행 클로저로 넘긴다.

export type TableMenuOp =
  | "row-above"
  | "row-below"
  | "col-left"
  | "col-right"
  | "del-rows"
  | "del-cols"
  | "del-table"
  | "align-left"
  | "align-center"
  | "align-right"
  | "sort-asc"
  | "sort-desc"
  | "clear-sel"
  | "copy-sel"
  | "merge"
  | "unmerge";

export interface TableMenuTarget {
  /** 우클릭한 셀(행 0 = 헤더). */
  row: number;
  col: number;
  /** 전체 행 수(헤더 포함)·열 수. */
  rows: number;
  cols: number;
  /** 셀 다중 선택(드래그·⇧클릭)이 있으면. */
  selection: CellRect | null;
  run: (op: TableMenuOp) => void;
}

let tableMenuHandler: ((target: TableMenuTarget, x: number, y: number) => void) | null = null;
export function setTableMenuHandler(
  fn: ((target: TableMenuTarget, x: number, y: number) => void) | null,
): void {
  tableMenuHandler = fn;
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
  // 빈 셀(공백만) — 줄 상자를 유지할 nbsp. 없으면 새로 삽입한 빈 행의
  // 높이가 패딩만으로 꺼진다(Word/Excel은 빈 행도 정상 높이 유지).
  if (!raw.trim()) frag.append("\u00A0"); // 줄 상자 유지(nbsp)
  return frag;
};

/** 셀 편집 후 되살릴 포커스(표 재생성 뒤 소비) — 표 시작 줄 번호 기준. */
let pendingCellFocus: { line: number; row: number; col: number } | null = null;

export function serializeTable(t: ParsedTable): string {
  const n = Math.max(t.header.length, 1);
  const esc = (c: string) => c.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
  const fix = (r: string[]) => Array.from({ length: n }, (_, i) => esc(r[i] ?? ""));
  const line = (r: string[]) => `| ${fix(r).join(" | ")} |`;
  const sep = Array.from({ length: n }, (_, i) => {
    const a = t.align[i];
    return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
  });
  return [line(t.header), `| ${sep.join(" | ")} |`, ...t.rows.map(line)].join("\n");
}

export class TableWidget extends WidgetType {
  #widths: number[] | null;

  constructor(
    readonly src: string,
    initialWidths?: number[],
    readonly onWidthsSaved?: (widths: number[]) => void,
  ) {
    super();
    this.#widths = initialWidths ? [...initialWidths] : null;
  }

  eq(other: TableWidget) {
    return other.src === this.src;
  }

  toDOM(view: EditorView) {
    const parsed = parseTable(this.src) ?? { align: [], header: [], rows: [] };
    const wrap = document.createElement("div");
    wrap.className = "md-table-wrap";
    const table = document.createElement("table");
    table.className = "md-table";
    table.style.tableLayout = "fixed"; // 열 폭 드래그가 정확히 반영되게.
    const nCols = Math.max(parsed.header.length, 1);
    const startLine = (): number => view.state.doc.lineAt(view.posAtDOM(wrap)).number;
    // 편집 중 다른 셀 클릭 — blur 커밋이 표를 재생성해도 클릭한 셀에서 이어지게(Word).
    // 캡처 단계에서 대상을 먼저 기록한다(blur는 그 뒤에 온다).
    let activeEdit: HTMLElement | null = null;
    let clickFocus: { row: number; col: number } | null = null;
    wrap.addEventListener(
      "mousedown",
      (e) => {
        clickFocus = null;
        if (!activeEdit) return;
        const cell = (e.target as HTMLElement | null)?.closest?.("td, th");
        const rowEl = cell?.closest?.("tr");
        if (!(cell instanceof HTMLElement) || !(rowEl instanceof HTMLElement)) return;
        const rows = Array.from(wrap.querySelectorAll("tr"));
        const r = rows.indexOf(rowEl);
        const c = gridColOf(cell, rowEl);
        if (r < 0 || c < 0) return;
        clickFocus = { row: r, col: c };
      },
      true,
    );
    // 변경된 구조를 원문에 반영(표 전체 재직렬화) — 위젯은 이후 재생성된다.
    const commit = (next: ParsedTable, focus?: { row: number; col: number }): void => {
      const from = view.posAtDOM(wrap);
      const to = from + this.src.length;
      if (view.state.sliceDoc(from, to) !== this.src) return;
      const text = serializeTable(next);
      if (focus) pendingCellFocus = { line: view.state.doc.lineAt(from).number, ...focus };
      if (text === this.src) {
        if (focus) restoreFocus(wrap);
        return;
      }
      view.dispatch({ changes: { from, to, insert: text }, userEvent: "input.tableCell" });
    };

    // — 셀 다중 선택(드래그·⇧클릭·⇧화살표) + 표 우클릭 메뉴(Word 표 선택·엑셀 사각 선택) —
    let selAnchor: { r: number; c: number } | null = null;
    let selRect: CellRect | null = null;
    let selActive: { r: number; c: number } | null = null; // 확장 모서리(⇧클릭·키보드 화살표)
    let dragSelecting = false;
    let suppressBegin = false;
    const cellAt = (target: EventTarget | null): { r: number; c: number } | null => {
      const cell = (target as HTMLElement | null)?.closest?.("td, th");
      const rowEl = cell?.closest?.("tr");
      if (!(cell instanceof HTMLElement) || !(rowEl instanceof HTMLElement)) return null;
      const r = Array.from(wrap.querySelectorAll("tr")).indexOf(rowEl);
      const c = gridColOf(cell, rowEl);
      return r < 0 || c < 0 ? null : { r, c };
    };
    const paintSelection = (): void => {
      wrap.querySelectorAll("td,th").forEach((cell) => cell.classList.remove("md-cell-selected"));
      if (!selRect) return;
      // 활성 셀이 시야를 벗어나면 따라감(키보드 이동·드래그 경계 자동 스크롤).
      const act = selActive ?? { r: selRect.r2, c: selRect.c2 };
      gridCellAt(Array.from(wrap.querySelectorAll("tr")), act.r, act.c)?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      }); // 메서드 옵셔널 — jsdom은 scrollIntoView 미구현
      const rows = Array.from(wrap.querySelectorAll("tr"));
      for (let r = selRect.r1; r <= selRect.r2; r++) {
        for (let c = selRect.c1; c <= selRect.c2; c++) {
          gridCellAt(rows, r, c)?.classList.add("md-cell-selected");
        }
      }
    };
    const clearSelection = (): void => {
      selAnchor = null;
      selRect = null;
      selActive = null;
      dragSelecting = false;
      paintSelection();
    };
    const applyOp = (mutate: (t: ParsedTable) => ParsedTable | null): void => {
      const next = mutate(parsed);
      if (next) commit(next);
    };
    const range = (a: number, b: number): number[] => {
      const out: number[] = [];
      for (let i = a; i <= b; i++) out.push(i);
      return out;
    };

    wrap.tabIndex = -1; // 선택 키(Delete·Esc·⌘C)를 받기 위한 포커스 가능 요소
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || view.state.readOnly) return;
      const rc = cellAt(e.target);
      if (!rc) return;
      if (selRect && e.shiftKey) {
        // ⇧클릭 — 앵커에서 클릭 셀까지 확장(편집 시작 억제).
        e.preventDefault();
        suppressBegin = true;
        selActive = rc;
        selRect = tableOps.normRect(selAnchor ?? rc, rc);
        paintSelection();
        wrap.focus();
        return;
      }
      if (selRect) {
        const inside =
          rc.r >= selRect.r1 && rc.r <= selRect.r2 && rc.c >= selRect.c1 && rc.c <= selRect.c2;
        if (inside) {
          // 선택 안 클릭 — 선택 유지(편집 억제).
          e.preventDefault();
          wrap.focus();
          return;
        }
        clearSelection(); // 밖 클릭 — 해제 후 일반 흐름(클릭=편집)
      }
      selAnchor = rc;
      suppressBegin = false;
      // 드래그 — 다른 셀로 넘어가면 선택 모드(클릭=편집 예약 취소).
      const onMove = (ev: MouseEvent): void => {
        const cur = cellAt(ev.target);
        if (!cur) return;
        if (!dragSelecting && cur.r === rc.r && cur.c === rc.c) return;
        if (!dragSelecting) {
          dragSelecting = true;
          suppressBegin = true;
          // 편집 시작 직후 드래그 — 블러로 취소(값 불변 → 렌더 복원).
          if (activeEdit) activeEdit.blur();
        }
        selRect = tableOps.normRect(selAnchor ?? rc, cur);
        selActive = cur;
        paintSelection();
        ev.preventDefault();
      };
      const onUp = (): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        if (dragSelecting) {
          dragSelecting = false;
          setTimeout(() => {
            suppressBegin = false;
          }, 0);
          wrap.focus();
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
    wrap.addEventListener("keydown", (e) => {
      if (!selRect) {
        // 선택이 없어도(Esc로 닫은 뒤) 포커스가 표 안에 있으면 화살표로 재시작
        // — 좌상단 단일 셀부터(이동은 일반 화살표가 이어받는다).
        if (
          !activeEdit &&
          !e.isComposing &&
          !e.shiftKey &&
          (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") &&
          wrap.contains(document.activeElement)
        ) {
          e.preventDefault();
          const start = { r: 0, c: 0 };
          selAnchor = start;
          selActive = start;
          selRect = tableOps.normRect(start, start);
          paintSelection();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        clearSelection();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        const rect = selRect;
        applyOp((t) => tableOps.clearCells(t, rect));
        clearSelection();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        const rect = selRect;
        void navigator.clipboard?.writeText(tableOps.tsvOf(parsed, rect)).catch(() => {});
      } else if (
        !activeEdit &&
        !e.isComposing &&
        !e.shiftKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        // 일반 화살표 — 활성 셀 이동(엑셀 모델: 이동→⇧확장→Enter 편집).
        // 단일 셀 선택으로 접는다(확장은 ⇧화살표가 담당).
        e.preventDefault();
        const maxR = Array.from(wrap.querySelectorAll("tr")).length - 1;
        const act0 = selActive ?? { r: selRect!.r1, c: selRect!.c1 };
        const act = {
          r:
            e.key === "ArrowUp" || e.key === "ArrowDown"
              ? Math.max(0, Math.min(maxR, act0.r + (e.key === "ArrowDown" ? 1 : -1)))
              : act0.r,
          c:
            e.key === "ArrowLeft" || e.key === "ArrowRight"
              ? Math.max(0, Math.min(nCols - 1, act0.c + (e.key === "ArrowRight" ? 1 : -1)))
              : act0.c,
        };
        selAnchor = act;
        selActive = act;
        selRect = tableOps.normRect(act, act);
        paintSelection();
      } else if (
        !activeEdit &&
        !e.isComposing &&
        !e.shiftKey &&
        e.key === "Enter" &&
        selActive !== null
      ) {
        // Enter — 선택(액티브 모서리) 셀 편집 진입. 마우스 클릭이 유일한 진입이던
        // 것을 닫는다(화살표 선택→Enter 편집→Tab 이동 — 전 키보드 표 편집).
        e.preventDefault();
        const cell = gridCellAt(Array.from(wrap.querySelectorAll("tr")), selActive.r, selActive.c);
        if (cell) {
          clearSelection();
          editBeginners.get(cell)?.();
        }
      } else if (
        !activeEdit &&
        !e.isComposing &&
        e.shiftKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")
      ) {
        // ⇧화살표 — 사각 선택을 키보드로 확장(엑셀 확장 선택).
        e.preventDefault();
        const maxR = Array.from(wrap.querySelectorAll("tr")).length - 1;
        const maxC = nCols - 1;
        const act = selActive ?? { r: selRect.r1, c: selRect.c1 };
        const next = {
          r:
            e.key === "ArrowUp" || e.key === "ArrowDown"
              ? Math.max(0, Math.min(maxR, act.r + (e.key === "ArrowDown" ? 1 : -1)))
              : act.r,
          c:
            e.key === "ArrowLeft" || e.key === "ArrowRight"
              ? Math.max(0, Math.min(maxC, act.c + (e.key === "ArrowRight" ? 1 : -1)))
              : act.c,
        };
        selAnchor = selAnchor ?? act;
        selActive = next;
        selRect = tableOps.normRect(selAnchor, next);
        paintSelection();
      } else if (
        !activeEdit &&
        (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) &&
        selActive !== null
      ) {
        // 메뉴 키·⇧F10 — 표 메뉴를 키보드로 호출(14개 오퍼레이션 전부 도달).
        // window의 일반 메뉴 ⇧F10까지 전파되면 표 메뉴를 덮어쓴다 — 차단.
        e.preventDefault();
        e.stopPropagation();
        const cell = gridCellAt(Array.from(wrap.querySelectorAll("tr")), selActive.r, selActive.c);
        const box = cell?.getBoundingClientRect();
        if (box) openTableMenu(selActive, box.left, box.bottom + 4);
      }
    });
    wrap.addEventListener("focusout", () => {
      // 포커스가 표 밖으로 완전히 나가면 선택 해제(셀 편집 이동은 유지).
      setTimeout(() => {
        if (!wrap.contains(document.activeElement) && !dragSelecting) clearSelection();
      }, 0);
    });
    // 표 메뉴 타깃 조립(우클릭·키보드 메뉴 키 공용).
    const openTableMenu = (rc: { r: number; c: number }, x: number, y: number): void => {
      if (view.state.readOnly) return; // 읽기 모드 — 일반 메뉴도 표 전용 항목 없음
      const rect = selRect ?? tableOps.normRect(rc, rc);
      tableMenuHandler?.(
        {
          row: rc.r,
          col: rc.c,
          rows: parsed.rows.length + 1,
          cols: nCols,
          selection: selRect,
          run: (op) => {
            switch (op) {
              case "row-above":
                applyOp((t) => tableOps.insertRow(t, rect.r1 - 1));
                break;
              case "row-below":
                applyOp((t) => tableOps.insertRow(t, rect.r2));
                break;
              case "col-left":
                applyOp((t) => tableOps.insertCol(t, rect.c1 - 1));
                break;
              case "col-right":
                applyOp((t) => tableOps.insertCol(t, rect.c2));
                break;
              case "del-rows":
                applyOp((t) => tableOps.deleteRows(t, range(rect.r1, rect.r2)));
                break;
              case "del-cols":
                applyOp((t) => tableOps.deleteCols(t, range(rect.c1, rect.c2)));
                break;
              case "del-table": {
                const from = view.posAtDOM(wrap);
                const to = from + this.src.length;
                const after = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + 1));
                view.dispatch({
                  changes: { from, to: to + (after === "\n" ? 1 : 0), insert: "" },
                  userEvent: "delete.table",
                });
                break;
              }
              case "align-left":
              case "align-center":
              case "align-right":
                applyOp((t) => tableOps.setColAlign(t, rc.c, op.slice(6) as "left" | "center" | "right"));
                break;
              case "sort-asc":
                applyOp((t) => tableOps.sortRowsBy(t, rc.c, false));
                break;
              case "sort-desc":
                applyOp((t) => tableOps.sortRowsBy(t, rc.c, true));
                break;
              case "clear-sel":
                applyOp((t) => tableOps.clearCells(t, rect));
                clearSelection();
                break;
              case "copy-sel":
                void navigator.clipboard?.writeText(tableOps.tsvOf(parsed, rect)).catch(() => {});
                break;
              case "merge":
                applyOp((t) => tableOps.mergeCells(t, rect));
                clearSelection();
                break;
              case "unmerge":
                applyOp((t) => tableOps.unmergeCells(t, rect));
                clearSelection();
                break;
            }
          },
        },
        x,
        y,
      );
    };
    wrap.addEventListener("contextmenu", (e) => {
      const rc = cellAt(e.target);
      if (!rc) return; // 셀 밖(여백) — 일반 메뉴
      e.preventDefault();
      e.stopPropagation();
      openTableMenu(rc, e.clientX, e.clientY);
    });
    // 셀을 Word처럼 제자리 편집: 포커스 시 원문(마크다운) 노출, 블러/Enter/Tab 시 반영.
    // editBeginners — 키보드(Enter) 진입용: 셀 요소 → 편집 시작 함수.
    const editBeginners = new Map<HTMLElement, () => void>();
    const makeEditable = (cell: HTMLElement, row: number, col: number, onDblClick = false): void => {
      const raw = (row === 0 ? parsed.header[col] : parsed.rows[row - 1]?.[col]) ?? "";
      let editing = false;
      let cancelled = false;
      const begin = () => {
        if (editing || suppressBegin) return;
        editing = true;
        cancelled = false;
        cell.contentEditable = "true";
        cell.textContent = raw;
        cell.classList.add("md-cell-editing");
        activeEdit = cell;
        cell.focus();
        const sel = window.getSelection();
        if (sel) {
          const r = document.createRange();
          r.selectNodeContents(cell);
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
      };
      editBeginners.set(cell, begin);
      const finish = (focus?: { row: number; col: number }): void => {
        if (!editing) return;
        editing = false;
        if (activeEdit === cell) activeEdit = null;
        cell.classList.remove("md-cell-editing");
        const value = cancelled ? raw : (cell.textContent ?? "").replace(/\s*\n\s*/g, " ").trim();
        // 셀 DOM은 항상 렌더 상태로 되돌린다 — 포커스 이동(값 불변)·커밋 가드
        // 탈락 경로에서 contentEditable이 남으면 이전 셀 테두리가 굳는다.
        cell.contentEditable = "false";
        cell.textContent = "";
        cell.append(tableCellText(raw));
        if (value === raw && !focus) return;
        const next: ParsedTable = {
          align: parsed.align,
          header: [...parsed.header],
          rows: parsed.rows.map((r) => [...r]),
        };
        if (row === 0) next.header[col] = value;
        else if (next.rows[row - 1]) next.rows[row - 1][col] = value;
        if (focus && focus.row > next.rows.length) {
          next.rows.push(Array.from({ length: nCols }, () => ""));
        }
        commit(next, focus);
      };
      if (onDblClick) cell.addEventListener("dblclick", (e) => { e.preventDefault(); begin(); });
      else cell.addEventListener("mousedown", () => { if (!editing) setTimeout(begin, 0); });
      cell.addEventListener("keydown", (e) => {
        if (!editing || e.isComposing) return;
        if (e.key === "Escape") {
          e.preventDefault();
          cancelled = true;
          cell.blur();
        } else if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          finish({ row: Math.max(row - 1, 0), col }); // ⇧Enter — 위 셀로(Enter는 아래)
        } else if (e.key === "Enter") {
          e.preventDefault();
          finish({ row: Math.min(row + 1, parsed.rows.length + 1), col });
        } else if (e.key === "Tab") {
          e.preventDefault();
          let r = row;
          let c = col + (e.shiftKey ? -1 : 1);
          if (c < 0) { r -= 1; c = nCols - 1; }
          else if (c >= nCols) { r += 1; c = 0; }
          if (r < 0) return;
          finish({ row: r, col: c });
        }
      });
      cell.addEventListener("blur", () => {
        // 클릭으로 옮겨가는 중이면 그 셀을 이어 편집(재생성 후 restoreFocus).
        const f = clickFocus;
        clickFocus = null;
        finish(f ?? undefined);
      });
      cell.addEventListener("paste", (e) => {
        e.preventDefault();
        document.execCommand("insertText", false, e.clipboardData?.getData("text/plain") ?? "");
      });
    };
    const restoreFocus = (w: HTMLElement) => {
      const pf = pendingCellFocus;
      pendingCellFocus = null;
      if (!pf) return;
      const cell = gridCellAt(Array.from(w.querySelectorAll("tr")), pf.row, pf.col);
      if (cell instanceof HTMLElement) {
        cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: false }));
        if (!cell.classList.contains("md-cell-editing")) cell.dispatchEvent(new MouseEvent("mousedown"));
      }
    };
    // 열 폭 상태(재생성에도 유지 — 위젯 인스턴스가 살아 있는 동안).
    const colgroup = document.createElement("colgroup");
    for (let i = 0; i < nCols; i++) {
      const col = document.createElement("col");
      const w = this.#widths?.[i];
      if (w) col.style.width = `${w}px`;
      colgroup.append(col);
    }
    table.append(colgroup);
    const thead = document.createElement("thead");
    const hrow = document.createElement("tr");
    parsed.header.forEach((cell, i) => {
      // 가로 병합 고스트(">")는 렌더하지 않는다 — 이전 실셀이 span 흡수.
      let hSpan = 1;
      while (i + hSpan < parsed.header.length && (parsed.header[i + hSpan] ?? "").trim() === ">") hSpan++;
      if (cell.trim() === ">") return;
      const th = document.createElement("th");
      const a = parsed.align[i];
      if (a) th.style.textAlign = a;
      // 헤더 클릭 → 정렬 토글(Word 표 머리글 정렬 버튼에 대응).
      th.addEventListener("click", (e) => {
        e.preventDefault();
        tableHeaderClickHandler?.(i, e.altKey);
      });
      // 열 너비 드래그 핸들(마지막 열 제외) — **표시 폭만** 조절(원문 불변).
      if (i < nCols - 1) {
        const handle = document.createElement("span");
        handle.className = "md-col-handle";
        handle.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const startX = e.clientX;
          const col = colgroup.children[i] as HTMLElement;
          const startW = col.getBoundingClientRect().width;
          const move = (ev: PointerEvent) => {
            const w = Math.max(48, startW + ev.clientX - startX);
            col.style.width = `${w}px`;
          };
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            this.#widths = Array.from(colgroup.children).map(
              (c) => (c as HTMLElement).getBoundingClientRect().width,
            );
            // 사이드카 저장 — 원문 불변.
            this.onWidthsSaved?.(this.#widths);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        });
        th.append(handle);
      }
      th.append(tableCellText(cell));
      makeEditable(th, 0, i, true);
      // 정렬 상태 표시(Word 표 도구의 정렬 아이콘에 대응).
      if (a === "left") th.dataset.align = "↤";
      else if (a === "center") th.dataset.align = "↔";
      else if (a === "right") th.dataset.align = "↦";
      if (hSpan > 1) th.colSpan = hSpan; // 가로 병합
      th.dataset.gridC = String(i); // 그리드 좌표(고스트 셀 건너뛰기에 필수)
      hrow.append(th);
    });
    thead.append(hrow);
    table.append(thead);
    const tbody = document.createElement("tbody");
    parsed.rows.forEach((row, ri) => {
      const tr = document.createElement("tr");
      row.forEach((cell, i) => {
        const mark = cell.trim();
        if (mark === ">") return; // 가로 병합 고스트 — 왼쪽 실셀이 span 흡수
        if (mark === "^") return; // 세로 병합 고스트 — 위 실셀이 span 흡수
        let span = 1;
        while (i + span < row.length && (row[i + span] ?? "").trim() === ">") span++;
        let rowspan = 1;
        while (ri + rowspan < parsed.rows.length && (parsed.rows[ri + rowspan]?.[i] ?? "").trim() === "^") rowspan++;
        const td = document.createElement("td");
        const a = parsed.align[i];
        if (a) td.style.textAlign = a;
        if (span > 1) td.colSpan = span;
        if (rowspan > 1) td.rowSpan = rowspan;
        td.dataset.gridC = String(i);
        td.append(tableCellText(cell));
        makeEditable(td, ri + 1, i);
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(tbody);
    wrap.append(table);
    if (pendingCellFocus) {
      // 위젯이 DOM에 붙은 뒤 포커스 복원.
      setTimeout(() => {
        if (pendingCellFocus && pendingCellFocus.line === startLine()) restoreFocus(wrap);
      }, 0);
    }
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

// — 목록 글머리(Word 글머리 기호 — 깊이별 글리프) —

export class BulletWidget extends WidgetType {
  constructor(readonly glyph: string) {
    super();
  }

  eq(other: BulletWidget) {
    return other.glyph === this.glyph;
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "md-bullet";
    el.textContent = this.glyph;
    return el;
  }

  ignoreEvent() {
    return true;
  }
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

// — 프론트매터(YAML 메타) 패널 —

export class FrontMatterWidget extends WidgetType {
  constructor(readonly yaml: string) {
    super();
  }

  eq(other: FrontMatterWidget) {
    return other.yaml === this.yaml;
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "md-frontmatter-panel";
    // 클릭 → 문서 정보 대화상자(폼 편집 — 클릭=편집). 핸들러 없으면 원문 진입.
    wrap.addEventListener("mousedown", (e: Event) => {
      if ((e as MouseEvent).button !== 0) return;
      e.preventDefault();
      if (frontMatterEditHandler) {
        frontMatterEditHandler();
        return;
      }
      const pos = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: Math.min(pos + 1, view.state.doc.length) }, scrollIntoView: true });
      view.focus();
    });
    for (const [k, v] of parseFrontMatter(this.yaml)) {
      const row = wrap.appendChild(document.createElement("div"));
      row.className = "fm-row";
      const key = row.appendChild(document.createElement("span"));
      key.className = "fm-key";
      key.textContent = k;
      const val = row.appendChild(document.createElement("span"));
      val.className = "fm-value";
      val.textContent = v;
    }
    return wrap;
  }

  ignoreEvent() {
    return false;
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

// — 위키링크 [[이름]] —

export class WikiLinkWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly resolved: string | null,
    readonly anchor: string | null,
  ) {
    super();
  }

  eq(other: WikiLinkWidget) {
    return (
      other.label === this.label &&
      other.resolved === this.resolved &&
      other.anchor === this.anchor
    );
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = this.resolved ? "md-wikilink" : "md-wikilink is-missing";
    if (this.resolved) {
      el.setAttribute("data-wiki-path", this.resolved);
      if (this.anchor) el.setAttribute("data-wiki-anchor", this.anchor);
    }
    el.textContent = this.label;
    return el;
  }

  ignoreEvent() {
    return false; // 클릭은 cm의 링크 처리가 위임받는다
  }
}

/** 문서 정보 대화상자 열기 — App이 등록(위젯 클릭 → 폼 편집). */
export let frontMatterEditHandler: (() => void) | null = null;
export function setFrontMatterEditHandler(fn: (() => void) | null): void {
  frontMatterEditHandler = fn;
}

/** 메모 개수 배지 — 메모 줄 끝(여러 개면 N). */
export class CommentCountWidget extends WidgetType {
  constructor(readonly count: number, readonly onOpen: () => void) {
    super();
  }
  eq(other: CommentCountWidget) {
    return other.count === this.count;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-comment-badge";
    el.textContent = `💬${this.count > 1 ? this.count : ""}`;
    el.title = "메모 보기(클릭)";
    el.addEventListener("mousedown", (e: Event) => {
      e.preventDefault();
      this.onOpen();
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** 문단 기호(¶) — 서식 기호 보기가 켜졌을 때 줄 끝(Word 서식 기호). */
export class ParaMarkWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-fm-para";
    el.textContent = "¶";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

/** 인용 표시 [N] — 서지 항목 툴팁, 서지 정의로의 클릭은 이후 단계. */
export class CiteWidget extends WidgetType {
  constructor(
    readonly display: string,
    readonly entry: string,
    /** 서지 정의 줄로 이동(정의가 있을 때만 — Word Ctrl+클릭 이동). */
    readonly onJump: (() => void) | null = null,
  ) {
    super();
  }
  eq(other: CiteWidget) {
    // onJump(클로저)는 비교하지 않는다 — display·entry가 같으면 이동처도 같다.
    return other.display === this.display && other.entry === this.entry;
  }
  toDOM() {
    const el = document.createElement("sup");
    el.className = "md-cite";
    el.textContent = this.display;
    if (this.entry) el.title = this.entry;
    if (this.onJump) {
      el.classList.add("md-cite-link");
      el.title = this.entry;
      el.addEventListener("mousedown", (e: Event) => {
        e.preventDefault(); // 커서 점프 대신 이동
        e.stopPropagation(); // CM의 클릭-투-커서 처리 차단
        this.onJump!();
      });
    }
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** 이미지 설명 추가 칩 → 대화상자 — App이 등록(src와 클릭 위치 전달). */
export let imageCaptionHandler: ((src: string, pos: number) => void) | null = null;
export function setImageCaptionHandler(fn: ((src: string, pos: number) => void) | null): void {
  imageCaptionHandler = fn;
}
