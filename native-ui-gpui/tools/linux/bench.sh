#!/usr/bin/env bash
# bench.sh <out.json>: one measured stream at 1280x800 with 60 typed keys, under the bake-off's shared lock, the way
# the Slint half's tools/bench.sh does it. Memory is read 5 s after the stream ends (smaps_rollup), as there.
# Needs a nested env sourced (nested-up.sh).
set -euo pipefail
out=$1
BIN=${BIN:-$HOME/.cache/sotto-cargo-target-gpui/release/sotto-gpui}
here=$(cd "$(dirname "$0")" && pwd)
exec 9> "$HOME/.cache/sotto-tmp/bakeoff-measure.lock"; flock 9
echo "loadavg $(cat /proc/loadavg)" > "$out.load"
env SOTTO_LAUNCH_T0=$(date +%s%N) SOTTO_GPUI_SIZE=1280x800 SOTTO_GPUI_METRICS="$out" SOTTO_GPUI_EXIT_AFTER_STREAM=1 \
  SOTTO_GPUI_MEMORY_AFTER_MS=5000 setsid -f "$BIN" > "$out.log" 2>&1 < /dev/null 9>&-
for _ in $(seq 100); do pid=$(pgrep -nf "^$BIN" || true); [ -n "$pid" ] && hyprctl clients -j | grep -q "\"pid\": $pid" && break; sleep 0.1; done
"$here/win.sh" "$pid" size 1280x800
sleep 4
# 60 keys, 150 ms apart, into the focused composer while the reply streams.
wtype -d 150 " and also check the receipts journal before we merge it ok"
while kill -0 "$pid" 2>/dev/null; do sleep 0.5; done
cat "$out"
