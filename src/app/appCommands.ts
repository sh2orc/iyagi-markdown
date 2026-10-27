/** App commands operate on documents, unlike native copy/paste/undo, which
 * belong to the focused text field and never pass through this router. */
export function guardAppCommands(
  isBlocked: () => boolean,
  run: (id: string) => void,
  onBlocked: () => void,
): (id: string) => void {
  return (id) => {
    if (isBlocked()) { onBlocked(); return; }
    run(id);
  };
}

function shortcutCommand(event: KeyboardEvent): string | null {
  if (!(event.metaKey || event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  if (event.altKey) {
    if (event.shiftKey) return null;
    if (key === "arrowleft") return "navigate-back";
    if (key === "arrowright") return "navigate-forward";
    if (key === "f") return "replace";
    // ⌥⌘T 목차 — ⇧⌘T는 닫은 탭 다시 열기(메뉴 가속기와 같은 배치).
    return key === "t" ? "toggle-toc" : null;
  }
  switch (key) {
    case "t": return event.shiftKey ? "reopen-closed-tab" : null;
    case "n": return event.shiftKey ? null : "new-tab";
    case "e": return event.shiftKey ? null : "mode-read";
    case "/": return event.shiftKey ? null : "mode-source";
    case "f": return event.shiftKey ? "workspace-search" : "find";
    case "g": return event.shiftKey ? "find-prev" : "find-next";
    case "s": return event.shiftKey ? "save-as" : "save";
    case "o": return event.shiftKey ? "open-folder" : "open";
    case "p": return event.shiftKey ? "command-palette" : "print";
    case ",": return event.shiftKey ? null : "settings";
    default: return null;
  }
}

/** Bubble after local handlers: a dialog's handled key and IME events win. */
export function handleAppShortcut(event: KeyboardEvent, dispatch: (id: string) => void): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  const id = shortcutCommand(event);
  if (!id) return;
  event.preventDefault();
  // Holding Save/Open must not create repeated pickers or blocked notices.
  if (!event.repeat) dispatch(id);
}
