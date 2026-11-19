#!/usr/bin/env bash
# match.sh <outdir>: today's composer states in Slint, cropped exactly as composer-reference/ crops Electron's, then compared.
set -euo pipefail
out=$1; mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd); ref=$here/../composer-reference
export SLINT_BACKEND=${SLINT_BACKEND:-winit-skia-opengl} BIN=${BIN:-$HOME/.cache/sotto-cargo-target/release/sotto-slint}
T="Before merging, check crash-after.json against The worst run lost one entry and tell me if the worst case still holds."
crop() { python3 -c "
import json,sys
from PIL import Image
r=json.load(open('$ref/$2.json'))['captureRectInWindow']
Image.open('$1').crop((r['x']-280, r['y'], r['x']-280+r['width'], r['y']+r['height'])).save('$out/$2.png')"; }
for mode in dark light; do
  flag=""; [ $mode = light ] && flag=--light
  "$here/run-shot.sh" "$out/full.png" 1000x800 2.5 --finished --no-tools $flag --composer-text "$T"; crop "$out/full.png" $mode-1b-typed
  "$here/run-shot.sh" "$out/full.png" 1000x800 2.5 --finished --no-tools $flag --composer-text "" --no-focus; crop "$out/full.png" $mode-1a-empty
  for m in "2 3a-permissions-menu" "3 3b-model-menu" "4 3c-effort-menu"; do
    set -- $m
    pid=$(KEEP=1 "$here/run-shot.sh" "$out/full.png" 1000x800 2 --finished --no-tools $flag --composer-text "")
    for _ in $(seq $1); do wtype -k Tab; sleep 0.1; done
    wtype -k Return; sleep 0.6
    "$here/win.sh" "$pid" shot "$out/full.png"; kill "$pid"
    crop "$out/full.png" $mode-$2
  done
done
for f in "$out"/*-1*.png "$out"/*-3*.png; do
  n=$(basename "$f" .png)
  echo "$n: $(python3 "$here/compare.py" "$ref/$n.png" "$f" "$out/cmp-$n.png" 2>/dev/null)"
done
