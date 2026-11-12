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

/** 미리보기 iframe 안 링크 클릭이 프레임 자체를 다른 주소로 보내지 못하게 한다
 *  (문서 안 #앵커 이동만 허용). 스크립트가 꺼진 프레임이라 부모가 건다. */
export function blockFrameNavigation(frame: HTMLIFrameElement | null): void {
  try {
    frame?.contentDocument?.addEventListener("click", (native) => {
      const anchor = (native.target as Element | null)?.closest?.("a");
      if (anchor && !anchor.getAttribute("href")?.startsWith("#")) native.preventDefault();
    });
  } catch {
    /* 접근 거부 — 프레임이 이미 교체됨 */
  }
}
