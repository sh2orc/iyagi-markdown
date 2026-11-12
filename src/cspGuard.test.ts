// CSP 스타일 가드 — 릴리스 빌드에서 편집기·수식이 통째로 깨지는 회귀를 막는다
// (2026-11-12 버그: 0.1.1 DMG에서 문서가 "제목 1…" 한 줄만 보이고 KaTeX가 비었다).
//
// 원인: Tauri는 번들 빌드 때 index.html의 인라인 <style>(부팅 스플래시)에 nonce를
// 주입하고 CSP style-src에 'nonce-…'를 덧붙인다. CSP 규칙상 nonce/해시가 있으면
// 'unsafe-inline'은 무시되므로 CodeMirror(style-mod의 <style>)와 KaTeX·mermaid의
// style="" 속성이 전부 차단된다. dev(devUrl)에서는 자산을 고치지 않아 재현되지 않는다.
// 규칙: style-src에 'unsafe-inline'을 두는 한 Tauri의 style-src 수정은 꺼 둔다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const security = conf.app.security;

function styleSrc(csp: string): string[] {
  const directive = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith("style-src "));
  return directive ? directive.split(/\s+/).slice(1) : [];
}

describe("CSP 스타일 가드", () => {
  it("style-src는 인라인 스타일을 허용한다(CodeMirror·KaTeX·mermaid 필요)", () => {
    expect(styleSrc(security.csp)).toContain("'unsafe-inline'");
  });

  it("Tauri가 style-src에 nonce를 넣어 'unsafe-inline'을 무력화하지 않는다", () => {
    const disabled = security.dangerousDisableAssetCspModification;
    const styleUntouched =
      disabled === true || (Array.isArray(disabled) && disabled.includes("style-src"));
    expect(styleUntouched).toBe(true);
  });

  it("스크립트 CSP 보호는 그대로 둔다(style-src만 예외)", () => {
    const disabled = security.dangerousDisableAssetCspModification;
    expect(disabled).not.toBe(true);
    expect(Array.isArray(disabled) && disabled.includes("script-src")).toBe(false);
  });
});
