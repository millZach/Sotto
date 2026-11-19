# compare.py <reference.png> <slint.png> <out.png>: the two side by side at 2x, then a difference image.
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert('RGB'); b = Image.open(sys.argv[2]).convert('RGB')
w, h = max(a.width, b.width), max(a.height, b.height)
pa = Image.new('RGB', (w, h)); pa.paste(a); pb = Image.new('RGB', (w, h)); pb.paste(b)
d = ImageChops.difference(pa, pb).point(lambda v: min(255, v * 4))
out = Image.new('RGB', (w, h * 3 + 8), (255, 0, 0)); out.paste(pa, (0, 0)); out.paste(pb, (0, h + 4)); out.paste(d, (0, 2 * h + 8))
out.resize((out.width * 2, out.height * 2), Image.NEAREST).save(sys.argv[3])
diff = sum(1 for p in ImageChops.difference(pa, pb).getdata() if max(p) > 24)
print(f'pixels differing by more than 24 of 255: {diff} of {w * h} ({100 * diff / (w * h):.1f}%)')
