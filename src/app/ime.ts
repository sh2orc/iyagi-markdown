// IME(한글 등) 조합 판정 — 입력 가능 요소의 keydown에서 앱 동작(Esc 닫기·
// Enter 저장 등)이 조합 취소·확정을 가로채지 않게 하는 가드.
//
// 주의(실측): React 합성 KeyboardEvent의 `isComposing`은 런타임에 null이다
// — 타입에는 있지만 매핑이 없다. 원시 이벤트에서 읽어야 한다. 네이티브
// addEventListener의 KeyboardEvent.isComposing은 정상 동작.

/** 조합 중이면 true — React 합성·네이티브 이벤트 양쪽에서 동작. */
export function imeComposing(e: { nativeEvent?: Event }): boolean {
  const native = e.nativeEvent as KeyboardEvent | undefined;
  if (native != null) return native.isComposing === true;
  return (e as unknown as KeyboardEvent).isComposing === true;
}
