#!/bin/sh
# Issue #2100: is the Threads list's scroll slower at the merge of #2023 than at the commit before it? One runner, one
# iPhone 16 Pro Max, both builds made as bench.sh makes them, taking turns in blocks of five journeys, the benchmark's own
# median, in the order before, merge, merge, before, so a runner that slows down and whichever side goes second weigh on
# both. Measuring branch only. Usage:
#   sh apps/ios/Scripts/scroll-ab.sh <report folder> <rounds of two blocks> <minutes to stop starting rounds at>
set -u
start=$(date +%s)
out=$1; rounds=$2; limit=$3
mkdir -p "$out"
root=$(git rev-parse --show-toplevel)
parent=377ecd44b897250e2598ca7319e6514884ddf501
control="$RUNNER_TEMP/before"
git worktree add --detach "$control" "$parent"
{ git -C "$root" log -1 --format='merge %H %s'; git -C "$control" log -1 --format='before %H %s'; git -C "$root" diff --stat "$parent" HEAD -- apps/ios/Sotto; } | tee "$out/source.txt"

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
device=$(xcrun simctl create "Sotto Scroll AB" "$1" "$2")
trap 'xcrun simctl shutdown "$device" >/dev/null 2>&1; xcrun simctl delete "$device" >/dev/null 2>&1' EXIT HUP INT TERM
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
xcrun simctl status_bar "$device" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100

optimized="SWIFT_OPTIMIZATION_LEVEL=-O SWIFT_COMPILATION_MODE=wholemodule GCC_OPTIMIZATION_LEVEL=s ENABLE_PREVIEWS=NO ENABLE_DEBUG_DYLIB=NO ENABLE_TESTABILITY=NO"
dir() { if [ "$1" = merge ]; then echo "$root/apps/ios"; else echo "$control/apps/ios"; fi; }
for side in before merge; do
    # shellcheck disable=SC2086
    (cd "$(dir "$side")" && xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
        -destination "platform=iOS Simulator,id=$device" -derivedDataPath .build-bench \
        $optimized ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build) > "$out/build-$side.log" 2>&1 \
        || { tail -60 "$out/build-$side.log"; echo "The $side side did not build."; exit 1; }
done

# One journey from a cold launch, as bench.sh's journey() runs it; a second argument turns the app's sampler on.
journey() {
    report=$1
    sampling=
    if [ $# -gt 1 ]; then sampling="--bench-sample $2"; fi
    rm -f "$report"
    xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
    sleep 2
    SIMCTL_CHILD_SOTTO_BENCH_FILE="$report" xcrun simctl launch "$device" com.millzach.sotto.ios \
        --ui-fixture --reset-ui-preferences --bench-threads 300 --bench-turns 200 --bench-chunks 200 --bench-journey all $sampling \
        -AppleLanguages '(en)' -AppleLocale en_US >/dev/null
    outcome=timed-out
    for _ in $(seq 1 600); do
        if [ -f "$report" ]; then
            if grep -q '"phase":"finished"' "$report"; then outcome=finished; break; fi
            if grep -q '"phase":"failed-' "$report"; then outcome=failed; break; fi
        fi
        sleep 1
    done
    echo "$(date -u +%H:%M:%SZ) $(basename "$report"): $outcome"
}

# Five journeys of one build, installed and warmed as bench.sh does before its own.
block() {
    side=$1; round=$2
    xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
    xcrun simctl install "$device" "$(dir "$side")/.build-bench/Build/Products/Debug-iphonesimulator/Sotto.app"
    xcrun simctl launch "$device" com.millzach.sotto.ios --ui-fixture >/dev/null || true
    sleep 8
    for run in 1 2 3 4 5; do
        name="$side-$round-$run"
        if [ $((round % 2)) = 0 ]; then journey "$out/$name.json" "$out/$name.samples.txt"; else journey "$out/$name.json"; fi
    done
    # The sampled journeys whose list drew again during the scroll, named while this build's images are still installed.
    if [ $((round % 2)) = 0 ]; then
        for run in 1 2 3 4 5; do
            name="$side-$round-$run"
            if python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["phases"]["list-scroll"]["counts"].get("body.ThreadListSections") else 1)' "$out/$name.json" 2>/dev/null; then
                python3 "$root/apps/ios/Scripts/bench-sample.py" "$out/$name.samples.txt" > "$out/trace-$name.md" 2> "$out/trace-$name.log" || true
            fi
        done
    fi
}

round=1
while [ "$round" -le "$rounds" ]; do
    if [ $(( ($(date +%s) - start) / 60 )) -ge "$limit" ]; then echo "Stopped before round $round: past $limit minutes."; break; fi
    if [ $((round % 2)) = 1 ]; then block before "$round"; block merge "$round"; else block merge "$round"; block before "$round"; fi
    python3 "$root/apps/ios/Scripts/scroll-ab-summary.py" "$out" > "$out/summary.md" || true
    round=$((round + 1))
done
xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
python3 "$root/apps/ios/Scripts/scroll-ab-summary.py" "$out" > "$out/summary.md"
cat "$out/summary.md"
