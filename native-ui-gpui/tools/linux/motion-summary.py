#!/usr/bin/env python3
# motion-summary.py <dir>: for each phase (motion, reduced, restored), how many pixels change between consecutive
# samples in each moving thing's region (1280x800 window), and whether the strip says "Reduced motion".
import sys
from PIL import Image, ImageChops
d = sys.argv[1]
regions = {'composer caret': (36, 704, 48, 736), 'Writing a reply': (20, 646, 130, 672),
           'stand-in page stripe': (808, 84, 1268, 92), 'strip note': (230, 8, 340, 30)}
for phase in ('motion', 'reduced', 'restored'):
    ims = [Image.open(f'{d}/{phase}-{i}.png').convert('RGB') for i in range(1, 9)]
    parts = []
    for name, box in regions.items():
        changes = []
        for a, b in zip(ims, ims[1:]):
            diff = ImageChops.difference(a.crop(box), b.crop(box)).convert('L').point(lambda v: 255 if v > 24 else 0)
            changes.append(sum(1 for p in diff.getdata() if p))
        parts.append(f'{name}: {changes}')
    print(f'{phase}: ' + ' | '.join(parts))
