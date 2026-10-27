import { useEffect, useRef } from "react";

/** Read-only HTML isolated from app styles. Same-origin lets the parent forward
 * Tab/Escape; scripts remain forbidden by both the sandbox and CSP. */
export function UserTemplatePreview({ html, theme, title }: {
  html: string; theme: "light" | "dark"; title: string;
}): JSX.Element {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => { cleanup.current?.(); }, []);
  const colors = theme === "dark" ? "color:#e5e7eb;background:#1e1e21" : "color:#24292f;background:#fff";
  return <iframe className="user-template-preview" title={title} tabIndex={0} sandbox="allow-same-origin" referrerPolicy="no-referrer"
    srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><style>body{font:14px/1.7 system-ui;overflow-wrap:anywhere;${colors}}table{border-collapse:collapse}td,th{border:1px solid #888;padding:6px}pre{white-space:pre-wrap}img{max-width:100%}</style></head><body>${html}</body></html>`}
    onLoad={(event) => {
      cleanup.current?.(); cleanup.current = null;
      const frame = event.currentTarget, doc = frame.contentDocument;
      if (!doc) return;
      const key = (native: KeyboardEvent) => {
        if (native.isComposing || native.defaultPrevented || (native.key !== "Tab" && native.key !== "Escape")) return;
        const forwarded = new KeyboardEvent("keydown", { key: native.key, shiftKey: native.shiftKey,
          altKey: native.altKey, ctrlKey: native.ctrlKey, metaKey: native.metaKey, repeat: native.repeat, bubbles: true, cancelable: true });
        frame.dispatchEvent(forwarded);
        if (forwarded.defaultPrevented) native.preventDefault();
      };
      doc.addEventListener("keydown", key);
      cleanup.current = () => doc.removeEventListener("keydown", key);
    }} />;
}
