#!/usr/bin/env python3
# caret-scan.py <pid> <out-dir> <text> [<Right|Left>]: types <text> into the focused composer, goes Home, then presses
# the arrow one step at a time and records where the caret is drawn (its x in the window, from the capture),
# so caret movement can be checked against the bidi layout. Needs a nested env sourced and a UTF-8 locale.
import subprocess, sys, os, json
from PIL import Image
pid, out, text = sys.argv[1], sys.argv[2], sys.argv[3]
arrow = sys.argv[4] if len(sys.argv) > 4 else 'Right'
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(out, exist_ok=True)
def key(*a): subprocess.run(['wtype', *a], check=True)
def shot(name):
    p = f'{out}/{name}.png'; subprocess.run([f'{here}/win.sh', pid, 'shot', p], check=True); return Image.open(p).convert('RGB')
def caret_x(im):
    # The composer's caret: a thin teal bar in the composer's text row (y 700..740 at 1280x800, variant A).
    xs = []
    for x in range(30, 780):
        hits = sum(1 for y in range(700, 742) if (lambda r, g, b: g > 150 and b > 140 and r < 150 and g - r > 50)(*im.getpixel((x, y))))
        if hits >= 8: xs.append(x)
    return xs
key('-M', 'ctrl', '-k', 'a', '-m', 'ctrl'); key('-k', 'BackSpace')
key(text)
key('-k', 'Home')
rows = []
for i in range(len(text) + 2):
    im = shot(f'step-{i:02d}')
    xs = caret_x(im)
    rows.append({'step': i, 'caret_x': xs})
    print(i, xs, flush=True)
    key('-k', arrow)
json.dump(rows, open(f'{out}/caret.json', 'w'))
