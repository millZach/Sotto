#!/usr/bin/env bash
# rebuild_time.sh <debug|release> <runs>: change the strip's colour in src/main.rs, rebuild, relaunch; edit to first
# frame, as the Slint half's tools/rebuild_time.sh does. GPUI has no live preview here (its Subsecond hot reload was
# tried on Windows and crashed), so this is the whole loop. Needs a nested env sourced; run from native-ui-gpui/.
set -euo pipefail
profile=$1; runs=$2
export TMPDIR=$HOME/.cache/sotto-tmp CARGO_TARGET_DIR=$HOME/.cache/sotto-cargo-target-gpui
flag=""; [ "$profile" = release ] && flag=--release
patch=${PATCH_CONFIG:-$HOME/.cache/sotto-gpui-zed-patch.toml}
BIN=$CARGO_TARGET_DIR/$([ "$profile" = release ] && echo release || echo debug)/sotto-gpui
A='.bg(t.chrome.hsla())'
B='.bg(gpui::rgb(0xff00ff))'
exec 9> "$HOME/.cache/sotto-tmp/bakeoff-measure.lock"; flock 9
cargo build $flag -j 8 --config "$patch" --bin sotto-gpui 9>&- > /dev/null 2>&1   # start from a built tree
for i in $(seq "$runs"); do
  for pair in "$A|$B" "$B|$A"; do
    from=${pair%%|*}; to=${pair#*|}
    t0=$(date +%s%N)
    python3 - "$from" "$to" <<'PY'
import sys; p='src/main.rs'; s=open(p).read(); assert s.count(sys.argv[1])==1, sys.argv[1]; open(p,'w').write(s.replace(sys.argv[1],sys.argv[2]))
PY
    b0=$(date +%s%N); cargo build $flag -j 8 --config "$patch" --bin sotto-gpui 9>&- > /dev/null 2>&1; b1=$(date +%s%N)
    log=$(mktemp)
    SOTTO_LAUNCH_T0=$t0 SOTTO_GPUI_AUTOSTREAM=600000 "$BIN" > "$log" 2>&1 9>&- &
    pid=$!; sleep 2; kill $pid; wait $pid 2>/dev/null || true
    echo "run $i build_ms=$(( (b1-b0)/1000000 )) $(grep first-frame "$log")"; rm -f "$log"
  done
done
