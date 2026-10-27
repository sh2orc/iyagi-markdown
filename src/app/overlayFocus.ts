import { useEffect, useRef, type RefObject } from "react";

const OVERLAY = '.overlay, [aria-modal="true"]';
const CONTROLS = 'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]';

function available(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]') || element.matches(":disabled")) return false;
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.visibility !== "collapse" && element.getClientRects().length > 0;
}

function topOverlay(root: HTMLElement): HTMLElement | null {
  let top: HTMLElement | null = null, highest = -Infinity;
  for (const element of root.querySelectorAll<HTMLElement>(OVERLAY)) {
    if (!available(element)) continue;
    const z = Number.parseInt(getComputedStyle(element).zIndex, 10) || 0;
    if (z >= highest) { highest = z; top = element; }
  }
  return top;
}

function controls(overlay: HTMLElement): HTMLElement[] {
  const candidates = [...overlay.querySelectorAll<HTMLElement>(CONTROLS)]
    .filter((element) => element.tabIndex >= 0 && available(element));
  // A radio group has one Tab stop, including groups with no checked value.
  return candidates.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) return true;
    const group = candidates.filter((other): other is HTMLInputElement => other instanceof HTMLInputElement
      && other.type === "radio" && other.name === element.name && other.form === element.form);
    return element === (group.find((radio) => radio.checked) ?? group[0]);
  }).sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

/** Own focus only while an overlay is present. No polling or editor-tree work
 * outside a modal session; DOM mutations during a session cover replacement,
 * stacked dialogs and controls becoming disabled during asynchronous actions. */
export function manageOverlayFocus(root: HTMLElement, restoreTarget: HTMLElement | null, fallback: () => void): () => void {
  let top: HTMLElement | null = null;
  let redirecting = false;
  const remembered = new Map<HTMLElement, HTMLElement>();
  const addedTabIndex = new Set<HTMLElement>();

  const enter = (overlay: HTMLElement) => {
    const previous = remembered.get(overlay);
    const target = previous && overlay.contains(previous) && available(previous)
      ? previous : controls(overlay)[0] ?? overlay;
    if (target === overlay && !overlay.hasAttribute("tabindex")) {
      overlay.tabIndex = -1;
      addedTabIndex.add(overlay);
    }
    redirecting = true;
    target.focus({ preventScroll: true });
    redirecting = false;
  };
  const refresh = () => {
    top = topOverlay(root);
    if (!top) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !top.contains(active) || !available(active)) enter(top);
    else remembered.set(top, active);
  };
  const onFocus = (event: FocusEvent) => {
    if (redirecting) return;
    top = topOverlay(root);
    if (!top) return;
    const target = event.target;
    if (target instanceof HTMLElement && top.contains(target) && available(target)) remembered.set(top, target);
    else enter(top);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || event.isComposing || event.defaultPrevented) return;
    top = topOverlay(root);
    if (!top) return;
    event.preventDefault();
    const items = controls(top);
    if (!items.length) { enter(top); return; }
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? (index <= 0 ? items.length - 1 : index - 1)
      : (index < 0 || index === items.length - 1 ? 0 : index + 1);
    items[next].focus();
  };
  document.addEventListener("focusin", onFocus);
  window.addEventListener("keydown", onKey, true);
  const observer = new MutationObserver(refresh);
  observer.observe(root, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["disabled", "hidden", "inert", "class", "style", "aria-hidden"] });
  refresh();
  return () => {
    observer.disconnect();
    document.removeEventListener("focusin", onFocus);
    window.removeEventListener("keydown", onKey, true);
    for (const element of addedTabIndex) if (element.getAttribute("tabindex") === "-1") element.removeAttribute("tabindex");
    // React clears background inert flags after effect cleanup. Let that commit
    // finish, and don't steal focus from a replacement dialog or explicit action.
    queueMicrotask(() => {
      if (!root.isConnected || topOverlay(root)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && available(active) && !top?.contains(active)) return;
      if (restoreTarget && available(restoreTarget)) restoreTarget.focus({ preventScroll: true });
      else fallback();
    });
  };
}

export function useOverlayFocus(root: RefObject<HTMLElement>, enabled: boolean, fallback: () => void): void {
  const previous = useRef<HTMLElement | null>(null);
  // Installed for the app lifetime so child autofocus/effects cannot overwrite
  // the opener before the modal-session effect starts.
  useEffect(() => {
    const remember = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && root.current?.contains(active)
        && !active.closest(OVERLAY)) previous.current = active;
    };
    remember();
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [root]);
  useEffect(() => {
    if (enabled && root.current) return manageOverlayFocus(root.current, previous.current, fallback);
  }, [root, enabled, fallback]);
}
