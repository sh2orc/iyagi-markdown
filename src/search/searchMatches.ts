export interface SearchQuery {
  text: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord?: boolean;
  replacement?: string;
}
export interface SearchMatch { from: number; to: number }
export const MAX_MATCHES = 5000;

export function sameSearch(a: SearchQuery | null, b: SearchQuery | null): boolean {
  return a === b || !!a && !!b && a.text === b.text && a.caseSensitive === b.caseSensitive &&
    a.regexp === b.regexp && !!a.wholeWord === !!b.wholeWord;
}
function pattern(query: SearchQuery): RegExp {
  const source = query.regexp ? query.text : query.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match the original string: lowercasing the whole document can change its
  // UTF-16 length (for example İ), corrupting subsequent selection offsets.
  return new RegExp(source, query.caseSensitive ? "gmu" : "gmiu");
}
export function validSearchQuery(query: SearchQuery): boolean {
  if (!query.text) return false;
  try { pattern(query); return true; } catch { return false; }
}
const word = /[\p{L}\p{N}\p{M}_]/u;
function charAt(text: string, index: number): string {
  const point = text.codePointAt(index);
  return point === undefined ? "" : String.fromCodePoint(point);
}
function charBefore(text: string, index: number): string {
  if (index <= 0) return "";
  const last = text.charCodeAt(index - 1);
  const previous = text.charCodeAt(index - 2);
  const paired = last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff;
  return text.slice(paired ? index - 2 : index - 1, index);
}

/** Every position and capture belongs to the original string, including empty matches. */
export function* scanMatches(text: string, query: SearchQuery): Generator<SearchMatch & { match: RegExpExecArray }> {
  if (!query.text) return;
  let re: RegExp;
  try { re = pattern(query); } catch { return; }
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const from = match.index, to = from + match[0].length;
    const boundary = !query.wholeWord ||
      !(word.test(charAt(match[0], 0)) && word.test(charBefore(text, from))) &&
      !(word.test(charBefore(match[0], match[0].length)) && word.test(charAt(text, to)));
    if (boundary) yield { from, to, match };
    if (!match[0].length) re.lastIndex += charAt(text, re.lastIndex).length || 1;
  }
}
export function computeMatches(text: string, query: SearchQuery, limit = MAX_MATCHES): SearchMatch[] {
  const matches: SearchMatch[] = [];
  if (limit <= 0) return matches;
  for (const { from, to } of scanMatches(text, query)) {
    matches.push({ from, to });
    if (matches.length >= limit) break;
  }
  return matches;
}

/** JavaScript replacement tokens, expanded from the same match used for finding. */
export function replacementText(query: SearchQuery, match: RegExpExecArray, text: string): string {
  const replacement = query.replacement ?? "";
  if (!query.regexp) return replacement;
  return replacement.replace(/\$(\$|&|`|'|<([^>]*)>|(\d{1,2}))/g, (literal, token: string, name: string | undefined) => {
    if (token === "$") return "$";
    if (token === "&") return match[0];
    if (token === "`") return text.slice(0, match.index);
    if (token === "'") return text.slice(match.index + match[0].length);
    if (name !== undefined) return match.groups ? match.groups[name] ?? "" : literal;
    const number = Number(token);
    if (number > 0 && number < match.length) return match[number] ?? "";
    const first = Number(token[0]);
    if (token.length === 2 && first > 0 && first < match.length) return (match[first] ?? "") + token[1];
    return literal;
  });
}
