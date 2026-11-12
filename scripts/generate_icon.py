#!/usr/bin/env python3
"""Render the IYAGI Markdown icon and its platform assets (requires Pillow)."""
from pathlib import Path
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src-tauri" / "icons"
SIZE = 1024
SCALE = 2
N = SIZE * SCALE


def box(values):
    return tuple(int(v * SCALE) for v in values)


# The inset gives the icon the breathing room expected in the macOS Dock.
canvas = Image.new("RGBA", (N, N))
shadow = Image.new("RGBA", (N, N))
sd = ImageDraw.Draw(shadow)
sd.rounded_rectangle(box((88, 102, 936, 950)), radius=190 * SCALE, fill=(15, 18, 58, 100))
shadow = shadow.filter(ImageFilter.GaussianBlur(20 * SCALE))
canvas.alpha_composite(shadow)

mask = Image.new("L", (N, N))
ImageDraw.Draw(mask).rounded_rectangle(box((88, 72, 936, 920)), radius=190 * SCALE, fill=255)
gradient = Image.new("RGBA", (1, N))
pixels = gradient.load()
for y in range(N):
    t = max(0, min(1, (y / SCALE - 72) / 848))
    pixels[0, y] = (int(100 - 53 * t), int(91 - 49 * t), int(239 - 91 * t), 255)
gradient = gradient.resize((N, N))
gradient.putalpha(mask)
canvas.alpha_composite(gradient)
draw = ImageDraw.Draw(canvas)
# Fine inset border adds definition against both light and dark backgrounds.
draw.rounded_rectangle(box((90, 74, 934, 918)), radius=188 * SCALE,
                       outline=(135, 130, 246, 255), width=3 * SCALE)

# A geometric M and a complete down arrow form the familiar Markdown mark.
white = (255, 255, 255, 255)
def line(points, width):
    points = [(int(x * SCALE), int(y * SCALE)) for x, y in points]
    draw.line(points, fill=white, width=width * SCALE, joint="curve")
    radius = width * SCALE // 2
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=white)

line([(250, 655), (250, 337), (390, 493), (530, 337), (530, 655)], 76)
line([(716, 342), (716, 639)], 76)
line([(646, 570), (716, 645), (786, 570)], 76)

source = canvas.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
OUT.mkdir(parents=True, exist_ok=True)
source.save(OUT / "icon-source.png")
for filename, size in {
    "32x32.png": 32, "64x64.png": 64, "128x128.png": 128,
    "128x128@2x.png": 256, "icon.png": 512,
    "Square30x30Logo.png": 30, "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71, "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150, "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310, "StoreLogo.png": 50,
}.items():
    source.resize((size, size), Image.Resampling.LANCZOS).save(OUT / filename)
source.save(OUT / "icon.ico", sizes=[(s, s) for s in (16, 32, 48, 64, 128, 256)])
with tempfile.TemporaryDirectory() as tmp:
    iconset = Path(tmp) / "icon.iconset"
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            pixels = size * scale
            suffix = "@2x" if scale == 2 else ""
            source.resize((pixels, pixels), Image.Resampling.LANCZOS).save(
                iconset / f"icon_{size}x{size}{suffix}.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")], check=True)
print(f"Rendered icon assets in {OUT}")
