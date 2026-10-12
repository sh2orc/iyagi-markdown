// CM·위젯 계층용 문구 주입 — widgets/plugins는 React 컨텍스트 밖이라 t에
// 닿지 못한다(store.phrases와 같은 방식: App이 언어에 맞춰 채운다).
// 기본값은 영어 — 앱 밖(단위 테스트)에서도 동작하게.

export interface WidgetPhrases {
  mathError: string;
  diagramError: string;
  imgMissing: string;
  imgLoadBlocked: string;
  linkOpen: string;
  saveFailed: string;
}

const DEFAULTS: WidgetPhrases = {
  mathError: "Math error",
  diagramError: "render failed",
  imgMissing: "Image not found",
  imgLoadBlocked: "Remote image blocked — click to load",
  linkOpen: "Open link",
  saveFailed: "Could not save the file",
};

export const phrases: WidgetPhrases = { ...DEFAULTS };

/** App이 t에서 채운다(null이면 기본값으로 되돌린다). */
export function setPhrases(p: Partial<WidgetPhrases> | null): void {
  Object.assign(phrases, DEFAULTS, p ?? {});
}
