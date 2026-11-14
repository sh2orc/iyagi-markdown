#!/usr/bin/env node
// render.mjs — intro.html을 프레임별로 캡처해 MP4(+미리보기 WebP)로 인코딩한다.
//
//   npm ci                                            # puppeteer-core(devDependency), katex, mermaid
//   node docs/media/intro/render.mjs                  # → docs/media/iyagi-markdown-intro.mp4/.webp
//   node docs/media/intro/render.mjs --still 8.5,15   # 그 시각의 PNG만 저장(확인용)
//   node docs/media/intro/render.mjs --webp-only      # 있는 MP4로 미리보기 WebP만 다시 만든다
//
// 브라우저는 시스템 Chrome(IYAGI_CHROME로 경로 지정), 인코더는 PATH의 ffmpeg(IYAGI_FFMPEG로 지정).
// ffmpeg에 libwebp가 없으면(Homebrew 기본 빌드) 미리보기는 libwebp의 img2webp로 만든다.
// intro.html이 node_modules의 KaTeX·mermaid를 읽으므로 저장소 루트를 127.0.0.1 HTTP로 띄워 연다
// (file://은 글꼴 교차 출처 제한에 걸린다).

import { spawn, execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const FPS = 30;
const SECONDS = 30;
const out = join(root, "docs/media");
const args = process.argv.slice(2);
const stillArg = args.indexOf("--still");
const chrome = process.env.IYAGI_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ffmpeg = process.env.IYAGI_FFMPEG ?? "ffmpeg";
const img2webp = process.env.IYAGI_IMG2WEBP ?? "img2webp";
const mp4 = join(out, "iyagi-markdown-intro.mp4");
const webp = join(out, "iyagi-markdown-intro.webp");

/** 미리보기: README에서 MP4로 연결되는 가벼운 애니메이션 WebP(12 fps, 폭 800). */
function makeWebp() {
  const vf = "fps=12,scale=800:-1:flags=lanczos";
  try {
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", mp4, "-vf", vf, "-c:v", "libwebp", "-quality", "70", "-loop", "0", webp], { stdio: "pipe" });
    return;
  } catch {
    console.log("ffmpeg has no libwebp — using img2webp");
  }
  const dir = mkdtempSync(join(tmpdir(), "iyagi-intro-"));
  try {
    execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", mp4, "-vf", vf, join(dir, "f%04d.png")]);
    const frames = readdirSync(dir).filter((f) => f.endsWith(".png")).sort().map((f) => join(dir, f));
    execFileSync(img2webp, ["-loop", "0", "-lossy", "-q", "70", "-m", "4", "-d", "83", ...frames, "-o", webp], { stdio: ["ignore", "ignore", "inherit"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (args.includes("--webp-only")) {
  makeWebp();
  console.log("wrote", webp);
  process.exit(0);
}

// 저장소 루트 정적 서버 — 루트 밖 경로는 거부한다.
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf" };
const server = createServer((req, res) => {
  const path = normalize(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/docs/media/intro/intro.html`;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--force-device-scale-factor=1", "--hide-scrollbars"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => window.__ready instanceof Promise);
await page.evaluate(() => window.__ready);
await page.evaluate(() => document.fonts.ready);

async function frame(t) {
  await page.evaluate((x) => window.__render(x), t);
  return page.screenshot({ type: "png" });
}

if (stillArg !== -1) {
  const dir = join(process.env.IYAGI_STILL_DIR ?? out, "stills");
  mkdirSync(dir, { recursive: true });
  for (const t of args[stillArg + 1].split(",").map(Number)) {
    const file = join(dir, `t${String(t).replace(".", "_")}.png`);
    writeFileSync(file, await frame(t));
    console.log("wrote", file);
  }
  await browser.close();
  server.close();
  process.exit(0);
}

mkdirSync(out, { recursive: true });
const enc = spawn(ffmpeg, [
  "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-r", String(FPS), mp4,
], { stdio: ["pipe", "inherit", "inherit"] });
const done = new Promise((res, rej) => { enc.on("exit", (c) => (c === 0 ? res() : rej(new Error("ffmpeg exited " + c)))); });

const total = FPS * SECONDS;
for (let f = 0; f < total; f++) {
  const png = await frame(f / FPS);
  if (!enc.stdin.write(png)) await new Promise((r) => enc.stdin.once("drain", r));
  if (f % 90 === 0) console.log(`frame ${f}/${total}`);
}
enc.stdin.end();
await done;
await browser.close();
server.close();

makeWebp();
console.log("wrote", mp4, webp);
