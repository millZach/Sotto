#!/usr/bin/env bash
# launch.sh <runs>: launch to first frame (the 200 messages on screen), under the shared lock.
set -euo pipefail
BIN=${BIN:-$HOME/.cache/sotto-cargo-target/release/sotto-slint}
exec 9> "$HOME/.cache/sotto-tmp/bakeoff-measure.lock"; flock 9
for i in $(seq "$1"); do
  SOTTO_LAUNCH_T0=$(date +%s%N) "$BIN" --launch-only 2>&1 9>&- | grep first-frame
  sleep 1
done
