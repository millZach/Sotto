#!/usr/bin/env bash
# captures.sh <outdir>: the screen at three sizes in both themes, the three composer variants, mid-stream with
# Jump to latest, and the transcript list focused. Needs a nested env sourced.
set -euo pipefail
out=$1; mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd)
export BIN=${BIN:-$HOME/.cache/sotto-cargo-target/release/sotto-slint} SLINT_BACKEND=${SLINT_BACKEND:-winit-skia-opengl}
for size in 1600x1000 1280x800 820x560; do
  "$here/run-shot.sh" "$out/screen-$size-dark.png" $size 2.5 --finished
  "$here/run-shot.sh" "$out/screen-$size-light.png" $size 2.5 --finished --light
done
for v in a b c; do
  "$here/run-shot.sh" "$out/composer-$v-dark.png" 1280x800 2.5 --finished --variant $v
  "$here/run-shot.sh" "$out/composer-$v-light.png" 1280x800 2.5 --finished --variant $v --light
  "$here/run-shot.sh" "$out/composer-$v-820-dark.png" 820x560 2.5 --finished --variant $v
done
"$here/run-shot.sh" "$out/streaming-diff.png" 1280x800 9.5 --stream
"$here/run-shot.sh" "$out/streaming-jump-to-latest.png" 1280x800 8 --stream --scroll-up-after 5000
