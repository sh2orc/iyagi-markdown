// CM·위젯 계층용 문구 주입 — widgets/plugins는 React 컨텍스트 밖이라 t에
// 닿지 못한다(store.phrases와 같은 방식: App이 언어에 맞춰 채운다).
// 기본값은 영어 — 앱 밖(단위 테스트)에서도 동작하게.

export interface WidgetPhrases {
  /** CM 본문 텍스트상자의 이름 — 스크린 리더가 "textbox"만 읽지 않게. */
  editorLabel: string;
  mathError: string;
  diagramError: string;
  imgMissing: string;
  imgLoadBlocked: string;
  linkOpen: string;
  linkOpenFailed: string;
  saveFailed: string;
  settingsSaveFailed: string;
  trackRestoreDeleted: string;
  speakStartedDoc: string;
  speakStartedSel: string;
  speakFailed: string;
  clipboardReadFailed: string;
  clipboardWriteFailed: string;
  clipboardTargetChanged: string;
  clipboardHtmlTooLarge: string;
  clipboardHtmlFailed: string;
}

const DEFAULTS: WidgetPhrases = {
  editorLabel: "Document editor",
  mathError: "Math error",
  diagramError: "render failed",
  imgMissing: "Image not found",
  imgLoadBlocked: "Remote image blocked — click to load",
  linkOpen: "Open link",
  linkOpenFailed: "Could not open the link",
  saveFailed: "Could not save the file",
  settingsSaveFailed: "Could not save settings",
  trackRestoreDeleted: "Restore deleted text",
  speakStartedDoc: "Reading the document aloud",
  speakStartedSel: "Reading the selection aloud",
  speakFailed: "Could not start reading aloud",
  clipboardReadFailed: "Could not read the clipboard. Use ⌘V to paste.",
  clipboardWriteFailed: "Could not copy to the clipboard. The document was kept.",
  clipboardTargetChanged: "The document or selected text changed; the pending clipboard edit was not applied.",
  clipboardHtmlTooLarge: "This HTML is too large to convert. Available plain text was kept.",
  clipboardHtmlFailed: "Could not convert the pasted HTML. Available plain text was kept.",
};

export const phrases: WidgetPhrases = { ...DEFAULTS };

/** App이 t에서 채운다(null이면 기본값으로 되돌린다). */
export function setPhrases(p: Partial<WidgetPhrases> | null): void {
  Object.assign(phrases, DEFAULTS, p ?? {});
}
