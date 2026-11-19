#!/usr/bin/env bash
# captures.sh <outdir>: the screen at three sizes in both themes once the reply has finished, and mid-stream.
# Needs a nested env sourced.
set -euo pipefail
out=$1; mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd)
for size in 1600x1000 1280x800 820x560; do
  "$here/run-shot.sh" "$out/screen-$size-dark.png" $size 23 SOTTO_GPUI_REDUCE_MOTION=1
  "$here/run-shot.sh" "$out/screen-$size-light.png" $size 23 SOTTO_GPUI_REDUCE_MOTION=1 SOTTO_GPUI_THEME=light
done
"$here/run-shot.sh" "$out/streaming-1280x800-dark.png" 1280x800 9
