/** Scripts remain sandboxed; the parent manages focus, scroll and readiness. */
export function connectPrintFrame(frame: HTMLIFrameElement, scroll: { current: number },
  onReady: () => void, onError: () => void): () => void {
  const doc = frame.contentDocument, win = frame.contentWindow;
  if (!doc || !win) { onError(); return () => {}; }
  let alive = true;
  const saveScroll = () => { scroll.current = win.scrollY; };
  const key = (native: KeyboardEvent) => {
    if (native.defaultPrevented || native.isComposing || native.keyCode === 229 ||
      (native.key !== "Tab" && native.key !== "Escape")) return;
    const forwarded = new KeyboardEvent("keydown", { key: native.key, shiftKey: native.shiftKey,
      ctrlKey: native.ctrlKey, metaKey: native.metaKey, altKey: native.altKey, repeat: native.repeat,
      bubbles: true, cancelable: true });
    frame.dispatchEvent(forwarded);
    if (forwarded.defaultPrevented) native.preventDefault();
  };
  const link = (native: MouseEvent) => {
    const anchor = (native.target as Element | null)?.closest?.("a");
    if (anchor && !anchor.getAttribute("href")?.startsWith("#")) native.preventDefault();
  };
  doc.addEventListener("keydown", key); doc.addEventListener("click", link);
  win.addEventListener("scroll", saveScroll, { passive: true });
  void Promise.resolve(doc.fonts?.ready).then(() => {
    if (!alive) return;
    win.scrollTo(0, scroll.current);
    onReady();
  }).catch(() => { if (alive) onError(); });
  return () => {
    alive = false; doc.removeEventListener("keydown", key); doc.removeEventListener("click", link);
    win.removeEventListener("scroll", saveScroll);
  };
}
