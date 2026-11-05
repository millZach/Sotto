#!/bin/sh
# Scratch only, never to merge: the long thread's open under each candidate change, one runner, one iPhone 16 Pro Max.
# Usage: sh apps/ios/Scripts/open-arms.sh <report folder> <base checkout> <rounds> <minutes to stop starting rounds at>
set -u
start=$(date +%s)
out=$1; base=$2; rounds=$3; limit=$4
mkdir -p "$out"
root=$(git rev-parse --show-toplevel)
xcrun simctl list runtimes --json > "$out/runtimes.json"
xcrun simctl list devicetypes --json > "$out/devicetypes.json"
set -- $(python3 - "$out" <<'PY'
import json, sys
from pathlib import Path
out = Path(sys.argv[1])
runtimes = json.loads((out / 'runtimes.json').read_text())['runtimes']
runtime = max((r for r in runtimes if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-')),
              key=lambda r: tuple(map(int, r['version'].split('.'))))
types = json.loads((out / 'devicetypes.json').read_text())['devicetypes']
print(next(d for d in types if d['name'] == 'iPhone 16 Pro Max')['identifier'], runtime['identifier'])
PY
)
device=$(xcrun simctl create "Sotto Open Arms" "$1" "$2")
trap 'xcrun simctl shutdown "$device" >/dev/null 2>&1; xcrun simctl delete "$device" >/dev/null 2>&1' EXIT HUP INT TERM
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
xcrun simctl status_bar "$device" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
optimized="SWIFT_OPTIMIZATION_LEVEL=-O SWIFT_COMPILATION_MODE=wholemodule GCC_OPTIMIZATION_LEVEL=s ENABLE_PREVIEWS=NO ENABLE_DEBUG_DYLIB=NO ENABLE_TESTABILITY=NO"
build() {
    # shellcheck disable=SC2086
    (cd "$1/apps/ios" && xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
        -destination "platform=iOS Simulator,id=$device" -derivedDataPath .build-bench \
        $optimized ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build) > "$out/build-$2.log" 2>&1 \
        || { tail -60 "$out/build-$2.log"; echo "$2 did not build."; exit 1; }
    echo "$(date -u +%H:%M:%SZ) built $2"
}
build "$base" base
build "$root" change
installed=""
use() {
    [ "$installed" = "$1" ] && return
    xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
    if [ "$1" = base ]; then dir=$base; else dir=$root; fi
    xcrun simctl install "$device" "$dir/apps/ios/.build-bench/Build/Products/Debug-iphonesimulator/Sotto.app"
    xcrun simctl launch "$device" com.millzach.sotto.ios --ui-fixture >/dev/null || true
    sleep 6
    installed=$1
}
journey() {
    report=$1; shift
    rm -f "$report"
    xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
    sleep 2
    SIMCTL_CHILD_SOTTO_BENCH_FILE="$report" xcrun simctl launch "$device" com.millzach.sotto.ios \
        --ui-fixture --reset-ui-preferences --bench-threads 300 --bench-turns 200 --bench-chunks 200 --bench-journey open \
        "$@" -AppleLanguages '(en)' -AppleLocale en_US >/dev/null
    outcome=timed-out
    for _ in $(seq 1 180); do
        if [ -f "$report" ]; then
            if grep -q '"phase":"finished"' "$report"; then outcome=finished; break; fi
            if grep -q '"phase":"failed-' "$report"; then outcome=failed; break; fi
        fi
        sleep 1
    done
    echo "$(date -u +%H:%M:%SZ) $(basename "$report"): $outcome"
}
arm() {
    case "$1" in
        base) use base; journey "$2" ;;
        manual) use change; journey "$2" ;;
        quiet) use change; journey "$2" --bench-eq --bench-quiet ;;
        tabs) use change; journey "$2" --bench-eq --bench-quiet --bench-tabs ;;
        warm) use change; journey "$2" --bench-warm ;;
        all) use change; journey "$2" --bench-eq --bench-quiet --bench-tabs --bench-warm ;;
    esac
}
round=1
while [ "$round" -le "$rounds" ]; do
    if [ $(( ($(date +%s) - start) / 60 )) -ge "$limit" ]; then echo "Stopped before round $round: past $limit minutes."; break; fi
    case $((round % 2)) in
        1) order="base manual quiet tabs warm all" ;;
        0) order="all warm tabs quiet manual base" ;;
    esac
    for side in $order; do arm "$side" "$out/$side-$round.json"; done
    round=$((round + 1))
done
xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
python3 "$root/apps/ios/Scripts/open-arms.py" "$out"
