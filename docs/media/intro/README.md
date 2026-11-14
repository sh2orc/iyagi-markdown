# Intro video

30-second motion graphic (English, 1920×1080, 30 fps). `intro.html` draws every frame as a pure
function of time (`window.__render(t)`); `render.mjs` serves the repository root on 127.0.0.1,
captures the page with headless Chrome (puppeteer-core) and encodes with ffmpeg. Math and the
diagram are drawn by the app's own renderers — KaTeX and mermaid from `node_modules`, with the
app's mermaid settings — and the motion follows the real editor: inline markers appear only
while the caret touches them, Source mode shows the raw text in the same font, a diagram is
selected on click and resized from its top-right handle.

```sh
npm ci                                            # puppeteer-core, katex, mermaid
node docs/media/intro/render.mjs                  # → docs/media/iyagi-markdown-intro.mp4 / .webp
node docs/media/intro/render.mjs --still 8.5,15   # PNG stills for review
```

Needs Google Chrome (`IYAGI_CHROME` to override the path) and ffmpeg on `PATH`
(`IYAGI_FFMPEG` to override).

Storyboard: 0–3.6 logo · 3.6–7.4 double-click a `.md`, it opens rendered · 7.4–10 Source ↔
Editing · 10–12.7 markers under the caret · 12.7–15 checkbox, table cell edit · 15–18.2 select
and resize a diagram · 18.2–22.4 exports, vector loupe · 22.4–26.2 principles · 26.2–30 outro.
