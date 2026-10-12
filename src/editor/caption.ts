// 이미지 캡션 판정 — ![대체텍스트](src)의 alt를 캡션으로 쓸지.
// 파일명을 그대로 적은 alt(스크린샷.png)는 캡션으로 쓰지 않는다(잡음 방지).
// 순수 함수 — 라이브 프리뷰 위젯·HTML 내보내기가 공유한다.

/** 캡션으로 쓸 만한 alt인지 — 비었거나 파일명·경로·너무 긴 값은 제외. */
export function captionWorthy(alt: string): boolean {
  const t = alt.trim();
  if (t.length < 2 || t.length > 120) return false;
  // 파일명/확장자 패턴 — 전체가 하나의 파일명이면 캡션 아님.
  if (/^[\w .()-]+\.(png|jpe?g|gif|webp|svg|bmp|heic|avif|tiff?)$/i.test(t)) return false;
  // 경로 조각(screenshot-2024, img_1234 같은 자동명) 토큰 하나로 끝나면 제외.
  if (/^(img|image|screenshot|screen|shot|pic|photo|figure|fig)[\s_-]*[\d-]*$/i.test(t)) return false;
  return true;
}
