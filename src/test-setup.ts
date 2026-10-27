// 전역 테스트 셋업 — jsdom이 구현하지 않는 브라우저 API의 no-op 스텁.
// 53차 사고: 위젯이 scrollIntoView를 호출하자 기존 테스트 7건이 TypeError로
// 붕괴(코드는 ?.()로 방어했지만 근본은 환경 차이). 새 코드가 이 부류 API를
// 호출해도 테스트가 죽지 않게 한다. 개별 테스트가 덮어쓰면 그것이 우선.
if (typeof window !== "undefined" && typeof Element !== "undefined") {
  const proto = Element.prototype as unknown as { scrollIntoView?: (o?: unknown) => void };
  if (!proto.scrollIntoView) {
    proto.scrollIntoView = () => {};
  }
}
// CodeMirror의 비동기 측정 루프(rAF → measureTextSize)가 Range 직사각형을
// 읽는다 — jsdom에는 없어서, 스텁 없는 테스트 파일에서 뷰를 만들면 테스트
// 종료 뒤에라도 미처리 TypeError로 Suite를 오염시킨다. 파일별 beforeAll 스텁과
// 같은 내용을 전역으로(개별 스텁이 있으면 그것이 우선).
if (typeof Range !== "undefined") {
  const proto = Range.prototype as unknown as {
    getClientRects?: () => DOMRectList;
    getBoundingClientRect?: () => DOMRect;
  };
  if (!proto.getClientRects) {
    proto.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (!proto.getBoundingClientRect) {
    proto.getBoundingClientRect = () => new DOMRect();
  }
}
