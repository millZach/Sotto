"""Count pixels that differ between consecutive captures inside a band.

python tools/band_diff.py x0 y0 x1 y1 a.png b.png [c.png ...]
"""
import sys
from PIL import Image, ImageChops

x0, y0, x1, y1 = (int(v) for v in sys.argv[1:5])
paths = sys.argv[5:]
total = 0
for a, b in zip(paths, paths[1:]):
    ia = Image.open(a).convert("RGB").crop((x0, y0, x1, y1))
    ib = Image.open(b).convert("RGB").crop((x0, y0, x1, y1))
    diff = ImageChops.difference(ia, ib).convert("L").point(lambda v: 255 if v > 8 else 0)
    n = sum(1 for v in diff.getdata() if v)
    total += n
    print(f"{a} -> {b}: {n}")
print(f"total changed pixels: {total}")
