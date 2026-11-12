// 내보내기 안전성 회귀 — 로컬 파일 인라인 범위, 치환 패턴, 미리보기 원격 차단.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { buildExportHtml, renderExportBody } from "./html";

afterEach(() => vi.unstubAllGlobals());

const base = { title: "T", baseDir: "/Users/me/docs", theme: "light" as const };

it("이미지 파일이 아닌 로컬 경로와 <img> 밖의 src는 읽지도 인라인하지도 않는다", async () => {
  const asked: string[] = [];
  const readBytes = async (path: string) => { asked.push(path); return new Uint8Array([1, 2, 3]); };
  const body = await renderExportBody(
    '![k](../.ssh/id_ed25519)\n\n<img src="/etc/passwd" width="1">\n\n<video src="../.aws/credentials"></video>\n\n![ok](pic.png)\n',
    { ...base, readBytes },
  );
  expect(asked).toEqual(["/Users/me/docs/pic.png"]);
  expect(body).toContain('src="data:image/png;base64,AQID"');
  expect(body).not.toContain("application/octet-stream");
});

it("mermaid 대체 코드의 `$` 치환 패턴을 글자 그대로 넣는다", async () => {
  const body = await renderExportBody(
    "before\n\n```mermaid\nnot a diagram $' and $` and $& x\n```\n\nAFTER-MARK\n",
    { ...base, inlineImages: false },
  );
  expect(body.split("AFTER-MARK").length - 1).toBe(1);
});

it("blockRemote는 미리보기 문서에 원격 이미지·미디어 차단 CSP를 넣는다", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ text: async () => "" })));
  const options = { ...base, baseDir: "", preRendered: "<p>x</p>" };
  const blocked = await buildExportHtml("x", { ...options, blockRemote: true });
  expect(blocked).toContain('http-equiv="Content-Security-Policy" content="img-src data: blob:; media-src data: blob:"');
  expect(await buildExportHtml("x", options)).not.toContain("Content-Security-Policy");
});
