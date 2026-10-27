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
  for (const child of Array.from(parent.childNodes)) {
    if (!(child instanceof HTMLElement)) {
      const text = child.textContent ?? "";
      if (text.trim()) out.push(escapeText(text.trim()));
      continue;
    }
    const tag = child.tagName.toLowerCase();
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
        // 워드의 빈 문단(&)은 무시, 나머지는 인라인 변환.
        const text = inline(child).trim();
        if (text) out.push(text);
        break;
      }
      case "br":
        break;
      case "ul":
      case "ol":
        out.push(...listBlock(child, depth));
        break;
      case "blockquote": {
        const inner = blocks(child, 0).trim();
        out.push(inner.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n"));
        break;
      }
      case "pre": {
        const codeEl = child.querySelector("code");
        const lang =
          (codeEl?.className || child.getAttribute("language") || "").match(
            /(?:language|lang)-([\w+-]+)/,
          )?.[1] ?? "";
        const text = (codeEl ?? child).textContent ?? "";
        const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
        out.push(`${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`);
        break;
      }
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
        // span/section/article 등 — 블록으로 재귀해 문맥 유지.
        const text = inline(child).trim();
        if (text) out.push(text);
        break;
      }
    }
    void cls;
  }
  return out.join("\n\n");
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
    for (const c of Array.from(li.childNodes)) {
      if (c instanceof HTMLElement && (c.tagName.toLowerCase() === "ul" || c.tagName.toLowerCase() === "ol")) {
        sublist.push(c);
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
        out += inner.includes("`") ? `\`\`${inner}\`` : `\`${inner}\``;
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
