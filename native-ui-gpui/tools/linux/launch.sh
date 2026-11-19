#!/usr/bin/env bash
# launch.sh <runs>: launch to first frame (the 200 messages on screen), under the shared lock, as the Slint half's
# tools/launch.sh does: SOTTO_LAUNCH_T0 is taken just before the process starts; the app logs the end of its first
# paint. Each run is stopped two seconds in. Needs a nested env sourced.
set -euo pipefail
BIN=${BIN:-$HOME/.cache/sotto-cargo-target-gpui/release/sotto-gpui}
exec 9> "$HOME/.cache/sotto-tmp/bakeoff-measure.lock"; flock 9
for i in $(seq "$1"); do
  log=$(mktemp)
  SOTTO_LAUNCH_T0=$(date +%s%N) SOTTO_GPUI_AUTOSTREAM=600000 "$BIN" > "$log" 2>&1 9>&- &
  pid=$!
  sleep 2; kill $pid; wait $pid 2>/dev/null || true
  grep first-frame "$log"; rm -f "$log"
  sleep 1
done
