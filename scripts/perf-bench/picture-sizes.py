#!/usr/bin/env python3
"""
How large the pictures a host keeps for its threads are, and how large each would be at the size an iPhone tile shows.

    python3 scripts/perf-bench/picture-sizes.py ~/.sotto/thread-media [sample]

It reads sizes, and resizes a random sample in memory with ImageMagick (`magick`) to a 640-pixel JPEG at quality 80,
the edge `PhotoPipeline.thumbnailEdge` uses. It writes nothing.
"""
import os
import random
import shutil
import statistics
import subprocess
import sys

root = os.path.expanduser(sys.argv[1])
sample_size = int(sys.argv[2]) if len(sys.argv) > 2 else 40


def is_picture(path):
    with open(path, 'rb') as handle:
        head = handle.read(12)
    return head[:8] == b'\x89PNG\r\n\x1a\n' or head[:3] == b'\xff\xd8\xff' or (head[:4] == b'RIFF' and head[8:12] == b'WEBP')


pictures = []
for folder, _, names in os.walk(root):
    for name in names:
        path = os.path.join(folder, name)
        if is_picture(path):
            pictures.append((path, os.path.getsize(path)))
sizes = [size for _, size in pictures]
print(f"{len(sizes)} pictures, {sum(sizes) / 1e6:.0f} MB; median {statistics.median(sizes) / 1e3:.0f} KB ({statistics.median(sizes) * 4 / 3 / 1e3:.0f} KB as base64), mean {statistics.mean(sizes) / 1e3:.0f} KB")
magick = shutil.which('magick') or shutil.which('convert')
if not magick:
    sys.exit('ImageMagick is not installed, so no thumbnail sizes.')
random.seed(7)
whole, small = [], []
for path, size in random.sample(pictures, min(sample_size, len(pictures))):
    made = subprocess.run([magick, path + '[0]', '-resize', '640x640>', '-quality', '80', 'jpg:-'], capture_output=True, timeout=60)
    if made.returncode == 0 and made.stdout:
        whole.append(size)
        small.append(len(made.stdout))
print(f"sample of {len(small)}: whole median {statistics.median(whole) / 1e3:.0f} KB, at 640 pixels median {statistics.median(small) / 1e3:.0f} KB; together {sum(whole) / 1e6:.1f} MB against {sum(small) / 1e6:.2f} MB")
