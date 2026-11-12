// HTML → 마크다운 변환(붙여넣기용) — Word·브라우저에서 복사한 서식을
// 원문 보존 방식(§4-1) 그대로 "마크다운 텍스트 삽입"으로 옮긴다.
// 외부 변환 라이브러리 없이 DOM 순회로 직접 변환 — 번들 가벼움 유지.

/** HTML 조각을 마크다운으로. 실패(빈 결과)면 null. */
export function htmlToMarkdown(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // 워드/브라우저 클립보드 꾸미미(comment, style, script, meta) 제거.
  doc.querySelectorAll("style, script, meta, title, link").forEach((el) => el.remove());
  const body = doc.body;
  if (!body || !body.textContent?.trim()) return null;
  const md = blocks(body, 0).replace(/\n{3,}/g, "\n\n").trim();
  return md.length > 0 ? md : null;
}

function blocks(parent: Node, depth: number): string {
  const out: string[] = [];
  // 이웃한 인라인 조각(텍스트·<b>·<a>·<span>…)은 한 문단으로 모은다 — 따로
  // 블록으로 내보내면 "글 **굵게** 글"이 세 문단으로 쪼개지고 서식도 잃는다.
  let run: Node[] = [];
  const flush = () => {
    if (!run.length) return;
    const span = document.createElement("span");
    for (const node of run) span.append(node.cloneNode(true));
    run = [];
    const text = inline(span).trim();
    if (text) out.push(text);
  };
  for (const child of Array.from(parent.childNodes)) {
    if (!(child instanceof HTMLElement)) {
      if (child.nodeType === Node.TEXT_NODE) run.push(child);
      continue;
    }
    const tag = child.tagName.toLowerCase();
    if (!BLOCK_ONLY.has(tag) && !hasBlockChild(child)) {
      run.push(child);
      continue;
    }
    flush();
    const cls = child.className || "";
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        out.push(`#${"#".repeat(Number(tag[1]) - 1)} ${inline(child).trim()}`);
        break;
      case "p":
      case "div": {
        // 블록을 감싼 래퍼(<div><h2>…</h2><p>…</p></div>)는 블록으로 재귀한다 —
        // 인라인으로 펴면 제목·문단·목록이 한 줄로 뭉개진다.
        if (hasBlockChild(child)) {
          const inner = blocks(child, depth);
          if (inner.trim()) out.push(inner);
          break;
        }
        // 워드의 빈 문단(&)은 무시, 나머지는 인라인 변환.
        const text = inline(child).trim();
        if (text) out.push(text);
        break;
      }
      case "br":
        break;
      case "ul":
      case "ol":
        // 목록은 한 블록 — 줄마다 따로 내보내면 항목 사이에 빈 줄이 끼어 느슨한 목록이 된다.
        out.push(listBlock(child, depth).join("\n"));
        break;
      case "blockquote": {
        const inner = blocks(child, 0).trim();
        out.push(inner.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
        break;
      }
      case "pre":
        out.push(fencedCode(child));
        break;
      case "table": {
        out.push(table(child));
        break;
      }
      case "hr":
        out.push("---");
        break;
      case "img": {
        const src = child.getAttribute("src") ?? "";
        const enc = src.replace(/[ ()]/g, (c) => (c === " " ? "%20" : c === "(" ? "%28" : "%29"));
        out.push(`![${child.getAttribute("alt") ?? ""}](${enc})`);
        break;
      }
      default: {
        // span/section/article, 구글 문서의 <b id="docs-internal-guid-…"> 래퍼 등 —
        // 블록을 품고 있으면 블록으로 재귀해 문맥 유지.
        if (hasBlockChild(child)) {
          const inner = blocks(child, depth);
          if (inner.trim()) out.push(inner);
          break;
        }
        const text = inline(child).trim();
        if (text) out.push(text);
        break;
      }
    }
    void cls;
  }
  flush();
  return out.join("\n\n");
}

/** blocks()가 직접 다루는 태그 — 나머지는 인라인 조각으로 모은다. */
const BLOCK_ONLY = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "br", "ul", "ol", "blockquote", "pre", "table", "hr", "img"]);
const BLOCK_TAGS = "p,div,h1,h2,h3,h4,h5,h6,ul,ol,table,pre,blockquote,hr,section,article,header,footer,main,figure";

function hasBlockChild(el: HTMLElement): boolean {
  return el.querySelector(BLOCK_TAGS) !== null;
}

/** 인라인 코드 — 내용은 원문 그대로(이스케이프 없음), 울타리는 내용의 가장 긴
 *  백틱 연속보다 하나 길게 양쪽 대칭으로. */
function codeSpan(text: string): string {
  const body = text.replace(/\n/g, " ");
  if (!body) return "";
  const fence = "`".repeat(longestBacktickRun(body) + 1);
  const pad = body.startsWith("`") || body.endsWith("`") ? " " : "";
  return `${fence}${pad}${body}${pad}${fence}`;
}

function fencedCode(pre: HTMLElement): string {
  const codeEl = pre.querySelector("code");
  const lang =
    (codeEl?.className || pre.getAttribute("language") || "").match(
      /(?:language|lang)-([\w+-]+)/,
    )?.[1] ?? "";
  const text = (codeEl ?? pre).textContent ?? "";
  const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`;
}

/** ul/ol → 마크다운 목록 줄들(하위 목록 재귀, 들여쓰기 2칸). */
function listBlock(el: HTMLElement, depth: number): string[] {
  const out: string[] = [];
  const ordered = el.tagName.toLowerCase() === "ol";
  let n = Number(el.getAttribute("start") ?? 1) || 1;
  for (const li of Array.from(el.children)) {
    if (li.tagName.toLowerCase() !== "li") continue;
    const sublist: HTMLElement[] = [];
    const inlines: string[] = [];
    const code: string[] = [];
    for (const c of Array.from(li.childNodes)) {
      if (c instanceof HTMLElement && (c.tagName.toLowerCase() === "ul" || c.tagName.toLowerCase() === "ol")) {
        sublist.push(c);
      } else if (c instanceof HTMLElement && c.tagName.toLowerCase() === "pre") {
        code.push(fencedCode(c));
      } else if (c instanceof HTMLElement && c.tagName.toLowerCase() === "p") {
        inlines.push(inline(c).trim());
      } else {
        const frag = document.createElement("span");
        frag.append(c.cloneNode(true));
        const t = inline(frag).trim();
        if (t) inlines.push(t);
      }
    }
    const head = inlines.join(" ");
    out.push(`${"  ".repeat(depth)}${ordered ? `${n}.` : "-"} ${head}`);
    // 항목 안 코드 블록 — 항목 내용 열에 맞춰 들여쓴 펜스로(여러 줄 보존).
    const pad = "  ".repeat(depth) + " ".repeat(ordered ? `${n}.`.length + 1 : 2);
    for (const block of code) out.push("", ...block.split("\n").map((l) => (l ? pad + l : l)), "");
    for (const sub of sublist) out.push(...listBlock(sub, depth + 1));
    if (ordered) n += 1;
  }
  return out;
}

/** 인라인 변환 — 굵게·기울임·취소·코드·링크·이미지·줄바꿈. */
function inline(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += escapeText(child.textContent ?? "");
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;
    const tag = child.tagName.toLowerCase();
    const inner = inline(child);
    switch (tag) {
      case "strong":
      case "b":
        out += inner.trim() ? `**${inner}**` : "";
        break;
      case "em":
      case "i":
        out += inner.trim() ? `*${inner}*` : "";
        break;
      case "del":
      case "s":
      case "strike":
        out += inner.trim() ? `~~${inner}~~` : "";
        break;
      case "code":
        out += codeSpan(child.textContent ?? "");
        break;
      case "a": {
        const href = child.getAttribute("href") ?? "";
        // CommonMark 목적지엔 공백을 못 쓴다 — wiki.ts와 같은 퍼센트 인코딩
        // (Word·브라우저 클립보드의 "my file.html" 같은 URL이 깨지지 않게).
        const enc = href.replace(/[ ()]/g, (c) => (c === " " ? "%20" : c === "(" ? "%28" : "%29"));
        out += href ? `[${inner || href}](${enc})` : inner;
        break;
      }
      case "img": {
        const src = child.getAttribute("src") ?? "";
        const enc = src.replace(/[ ()]/g, (c) => (c === " " ? "%20" : c === "(" ? "%28" : "%29"));
        out += `![${child.getAttribute("alt") ?? ""}](${enc})`;
        break;
      }
      case "br":
        out += "\n";
        break;
      case "span":
      case "u":
      case "mark":
      default:
        out += inner;
        break;
    }
  }
  return out;
}

/** HTML 표 → GFM 표. */
function table(el: HTMLElement): string {
  const rows = Array.from(el.querySelectorAll("tr"));
  if (rows.length === 0) return el.textContent?.trim() ?? "";
  const lines: string[] = [];
  rows.forEach((tr, i) => {
    const cells = Array.from(tr.children).map((c) => inline(c as HTMLElement).replace(/\n/g, " ").trim() || " ");
    lines.push(`| ${cells.join(" | ")} |`);
    if (i === 0) lines.push(`|${cells.map(() => "---").join("|")}|`);
  });
  return lines.join("\n");
}

function escapeText(text: string): string {
  // 마크다운 문자 이스케이프(과도하지 않게 — 흔한 것만).
  return text.replace(/([\\`*_{}[\]|<>#])/g, "\\$1");
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  let cur = 0;
  for (const c of text) {
    if (c === "`") {
      cur += 1;
      longest = Math.max(longest, cur);
    } else cur = 0;
  }
  return longest;
}
