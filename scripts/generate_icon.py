#!/usr/bin/env python3
"""IYAGI Markdown 앱 아이콘 생성 — 1024px 소스 PNG.

디자인: 짙은 인디고 라운드 사각형 위에 흰색 "M"과 아래 화살표(마크다운
상징). scripts/build-icon-assets.sh가 이 파일을 불러 다시 만든다.
"""
from PIL import Image, ImageDraw, ImageFilter
import math

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# — 라운드 사각형(macOS squircle 근사, 반지름 23%) —
R = int(SIZE * 0.23)
# 부드러운 수직 그라디언트: 인디고 → 더 깊은 인디고.
grad = Image.new("RGBA", (SIZE, SIZE))
gdraw = ImageDraw.Draw(grad)
top = (79, 70, 229)      # #4F46E5 indigo-600
bottom = (49, 46, 129)   # #312E81 indigo-900
for y in range(SIZE):
    t = y / SIZE
    # 살짝 지수 커브로 위가 밝게.
    tt = t ** 1.15
    c = tuple(int(top[i] + (bottom[i] - top[i]) * tt) for i in range(3)) + (255,)
    gdraw.line([(0, y), (SIZE, y)], fill=c)

mask = Image.new("L", (SIZE, SIZE), 0)
mdraw = ImageDraw.Draw(mask)
mdraw.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=R, fill=255)
img.paste(grad, (0, 0), mask)

# — "M" 자형(지오메트릭, 굵게) —
# strokes로 그린다: 세로줄 두 개 + 대각 두 개.
def stroke(draw, pts, width, fill):
    draw.line(pts, fill=fill, width=width, joint="curve")
    for p in [pts[0], pts[-1]]:
        r = width / 2 - 1
        draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=fill)

ink = (255, 255, 255, 255)
w = 118  # 획 두께
x0, x1 = 322, 702
ytop, ybot = 320, 640
m = [
    (x0, ybot),
    (x0, ytop),
    (x0 + (x1 - x0) / 2, (ytop + ybot) / 2 + 26),
    (x1, ytop),
    (x1, ybot),
]
stroke(draw, m, w, ink)

# — 아래 화살표(마크다운 다운마크) —
cx = SIZE / 2
ay = 758  # 화살표 중심
aw = 108  # 반폭
ah = 86   # 수직 길이
draw.line([(cx - aw / 2, ay - ah / 2), (cx, ay + ah / 2), (cx + aw / 2, ay - ah / 2)],
          fill=ink, width=96, joint="curve")
# 라인 조인트의 날카로움을 줄이는 살짝의 블러 후 다시 뚜렷하게.
img = img.filter(ImageFilter.GaussianBlur(1.2))

img.save("src-tauri/icons/icon-source.png")
print("src-tauri/icons/icon-source.png 기록")
