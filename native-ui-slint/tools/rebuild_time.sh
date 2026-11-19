#!/usr/bin/env bash
# rebuild_time.sh <debug|release> <runs>: edit a colour in composer.slint, rebuild, relaunch; edit to first frame.
set -euo pipefail
profile=$1; runs=$2
export TMPDIR=$HOME/.cache/sotto-tmp CARGO_TARGET_DIR=$HOME/.cache/sotto-cargo-target
flag=""; [ "$profile" = release ] && flag=--release
export SLINT_BACKEND=winit-skia-opengl
BIN=$CARGO_TARGET_DIR/$([ "$profile" = release ] && echo release || echo debug)/sotto-slint
A='background: root.variant == 2 ? Theme.surface-elevated : Theme.composer-card;'
B='background: root.variant == 2 ? Theme.surface-elevated : #ff00ff;'
exec 9> "$HOME/.cache/sotto-tmp/bakeoff-measure.lock"; flock 9
cargo build $flag 9>&- > /dev/null 2>&1   # start from a built tree
for i in $(seq "$runs"); do
  for pair in "$A|$B" "$B|$A"; do
    from=${pair%%|*}; to=${pair#*|}
    t0=$(date +%s%N)
    python3 - "$from" "$to" <<'PY'
import sys; p='ui/composer.slint'; s=open(p).read(); assert s.count(sys.argv[1])==1; open(p,'w').write(s.replace(sys.argv[1],sys.argv[2]))
PY
    b0=$(date +%s%N); cargo build $flag 9>&- > /dev/null 2>&1; b1=$(date +%s%N)
    line=$(SOTTO_LAUNCH_T0=$t0 "$BIN" --launch-only 2>&1 9>&- | grep first-frame)
    echo "run $i build_ms=$(( (b1-b0)/1000000 )) $line"
  done
done
