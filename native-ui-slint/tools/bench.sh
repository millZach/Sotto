#!/usr/bin/env bash
# bench.sh <out.json> [app args]: one measured stream at 1280x800 with 60 typed keys, under the shared lock.
set -euo pipefail
out=$1; shift
BIN=${BIN:-$HOME/.cache/sotto-cargo-target/release/sotto-slint}
here=$(cd "$(dirname "$0")" && pwd)
exec 9> "$HOME/.cache/sotto-tmp/bakeoff-measure.lock"; flock 9
echo "loadavg $(cat /proc/loadavg)" > "$out.load"
SOTTO_LAUNCH_T0=$(date +%s%N) setsid -f "$BIN" --bench --exit --out "$out" "$@" > "$out.log" 2>&1 < /dev/null 9>&-
for _ in $(seq 100); do pid=$(pgrep -nf "^$BIN" || true); [ -n "$pid" ] && hyprctl clients -j | grep -q "\"pid\": $pid" && break; sleep 0.1; done
"$here/win.sh" "$pid" size 1280x800
sleep 4
# 60 keys, 150 ms apart, into the focused composer while the reply streams.
wtype -d 150 " and also check the receipts journal before we merge it ok" 
while kill -0 "$pid" 2>/dev/null; do sleep 0.5; done
cat "$out"
