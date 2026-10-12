// 특수 문자 기호표(Word "기호" 대화상자) — 데이터 + 검색. 순수 모듈.
// name은 한글·영문 병기 — 검색은 대소문자 무시 부분 일치.

export interface SymbolEntry {
  ch: string;
  name: string;
  cat: SymbolCat;
}

export type SymbolCat = "punct" | "math" | "arrow" | "unit" | "shape" | "currency";

export const SYMBOL_CATS: Array<{ id: SymbolCat; labelKey: "symbolCatPunct" | "symbolCatMath" | "symbolCatArrow" | "symbolCatUnit" | "symbolCatShape" | "symbolCatCurrency" }> = [
  { id: "punct", labelKey: "symbolCatPunct" },
  { id: "math", labelKey: "symbolCatMath" },
  { id: "arrow", labelKey: "symbolCatArrow" },
  { id: "unit", labelKey: "symbolCatUnit" },
  { id: "shape", labelKey: "symbolCatShape" },
  { id: "currency", labelKey: "symbolCatCurrency" },
];

export const SYMBOLS: SymbolEntry[] = [
  // 문장부호
  { ch: "—", name: "엠대시 em dash", cat: "punct" },
  { ch: "–", name: "엔대시 en dash", cat: "punct" },
  { ch: "…", name: "말줄임 ellipsis", cat: "punct" },
  { ch: "·", name: "가운뎃점 middle dot", cat: "punct" },
  { ch: "“", name: "여는 큰따옴표 left quote", cat: "punct" },
  { ch: "”", name: "닫는 큰따옴표 right quote", cat: "punct" },
  { ch: "‘", name: "여는 작은따옴표 left single", cat: "punct" },
  { ch: "’", name: "닫는 작은따옴표 apostrophe", cat: "punct" },
  { ch: "«", name: "겹화살괄호 왼쪽 guillemet", cat: "punct" },
  { ch: "»", name: "겹화살괄호 오른쪽 guillemet", cat: "punct" },
  { ch: "§", name: "절 section", cat: "punct" },
  { ch: "¶", name: "문단 paragraph", cat: "punct" },
  { ch: "†", name: "단검 dagger", cat: "punct" },
  { ch: "‡", name: "겹단검 double dagger", cat: "punct" },
  // 수학
  { ch: "±", name: "플러스마이너스 plus minus", cat: "math" },
  { ch: "×", name: "곱하기 multiply", cat: "math" },
  { ch: "÷", name: "나누기 divide", cat: "math" },
  { ch: "≈", name: "근사 approximately", cat: "math" },
  { ch: "≠", name: "같지않음 not equal", cat: "math" },
  { ch: "≤", name: "작거나같음 less equal", cat: "math" },
  { ch: "≥", name: "크거나같음 greater equal", cat: "math" },
  { ch: "∞", name: "무한 infinity", cat: "math" },
  { ch: "∑", name: "합 sum sigma", cat: "math" },
  { ch: "√", name: "루트 root radical", cat: "math" },
  { ch: "∂", name: "편미분 partial", cat: "math" },
  { ch: "∫", name: "적분 integral", cat: "math" },
  { ch: "π", name: "파이 pi", cat: "math" },
  { ch: "∆", name: "델타 delta", cat: "math" },
  { ch: "∅", name: "공집합 empty set", cat: "math" },
  { ch: "∈", name: "속함 element of", cat: "math" },
  { ch: "⊂", name: "부분집합 subset", cat: "math" },
  // 화살표
  { ch: "→", name: "오른쪽 화살표 right arrow", cat: "arrow" },
  { ch: "←", name: "왼쪽 화살표 left arrow", cat: "arrow" },
  { ch: "↑", name: "위 화살표 up arrow", cat: "arrow" },
  { ch: "↓", name: "아래 화살표 down arrow", cat: "arrow" },
  { ch: "↔", name: "양쪽 화살표 left right arrow", cat: "arrow" },
  { ch: "⇒", name: "굵은 오른쪽 double arrow", cat: "arrow" },
  { ch: "⇔", name: "굵은 양쪽 double arrow", cat: "arrow" },
  { ch: "↖", name: "왼쪽 위 화살표", cat: "arrow" },
  { ch: "↗", name: "오른쪽 위 화살표", cat: "arrow" },
  { ch: "↘", name: "오른쪽 아래 화살표", cat: "arrow" },
  { ch: "↙", name: "왼쪽 아래 화살표", cat: "arrow" },
  { ch: "↦", name: "사상 maps to", cat: "arrow" },
  // 단위
  { ch: "°", name: "도 degree", cat: "unit" },
  { ch: "℃", name: "섭씨 celsius", cat: "unit" },
  { ch: "℉", name: "화씨 fahrenheit", cat: "unit" },
  { ch: "²", name: "제곱 superscript 2", cat: "unit" },
  { ch: "³", name: "세제곱 superscript 3", cat: "unit" },
  { ch: "½", name: "이분의일 one half", cat: "unit" },
  { ch: "¼", name: "사분의일 one quarter", cat: "unit" },
  { ch: "¾", name: "사분의삼 three quarters", cat: "unit" },
  { ch: "µ", name: "마이크로 micro", cat: "unit" },
  { ch: "Ω", name: "옴 ohm", cat: "unit" },
  { ch: "‰", name: "퍼밀 per mille", cat: "unit" },
  { ch: "％", name: "퍼센트 전각 percent", cat: "unit" },
  // 도형·표시
  { ch: "✓", name: "체크 check", cat: "shape" },
  { ch: "✗", name: "엑스 cross", cat: "shape" },
  { ch: "★", name: "별 검은 black star", cat: "shape" },
  { ch: "☆", name: "별 흰 white star", cat: "shape" },
  { ch: "●", name: "원 검은 black circle", cat: "shape" },
  { ch: "○", name: "원 흰 white circle", cat: "shape" },
  { ch: "◆", name: "다이아몬드 검은", cat: "shape" },
  { ch: "◇", name: "다이아몬드 흰", cat: "shape" },
  { ch: "■", name: "사각형 검은", cat: "shape" },
  { ch: "□", name: "사각형 흰", cat: "shape" },
  { ch: "▲", name: "삼각형 검은", cat: "shape" },
  { ch: "△", name: "삼각형 흰", cat: "shape" },
  { ch: "♥", name: "하트 heart", cat: "shape" },
  { ch: "©", name: "저작권 copyright", cat: "shape" },
  { ch: "®", name: "등록상표 registered", cat: "shape" },
  { ch: "™", name: "상표 trademark", cat: "shape" },
  // 통화
  { ch: "₩", name: "원 won", cat: "currency" },
  { ch: "$", name: "달러 dollar", cat: "currency" },
  { ch: "€", name: "유로 euro", cat: "currency" },
  { ch: "£", name: "파운드 pound", cat: "currency" },
  { ch: "¥", name: "엔·위안 yen yuan", cat: "currency" },
  { ch: "¢", name: "센트 cent", cat: "currency" },
];

/** 검색 — 대소문자 무시 이름 부분 일치. 빈 쿼리는 전체. 순수 함수. */
export function searchSymbols(query: string, cat?: SymbolCat): SymbolEntry[] {
  const q = query.trim().toLowerCase();
  return SYMBOLS.filter((s) => {
    if (cat && s.cat !== cat) return false;
    if (!q) return true;
    return s.name.toLowerCase().includes(q) || s.ch === query.trim();
  });
}
