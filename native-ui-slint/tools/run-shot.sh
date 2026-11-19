#!/usr/bin/env bash
# run-shot.sh <out.png> <WxH> <wait-seconds> [app args...]: launch, size, wait, capture, quit. Needs a nested env sourced.
set -euo pipefail
out=$1; size=$2; wait=$3; shift 3
BIN=${BIN:-$HOME/.cache/sotto-cargo-target/debug/sotto-slint}
here=$(cd "$(dirname "$0")" && pwd)
log=${LOG:-$HOME/.cache/sotto-tmp/run.log}
SOTTO_LAUNCH_T0=$(date +%s%N) setsid -f "$BIN" "$@" > "$log" 2>&1 < /dev/null
for _ in $(seq 100); do pid=$(pgrep -nf "^$BIN" || true); [ -n "$pid" ] && hyprctl clients -j | grep -q "\"pid\": $pid" && break; sleep 0.1; done
"$here/win.sh" "$pid" size "$size"
sleep "$wait"
"$here/win.sh" "$pid" shot "$out"
[ -n "${KEEP:-}" ] && { echo "$pid"; exit 0; }
kill "$pid"
