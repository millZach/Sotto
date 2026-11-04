#!/bin/sh
# What opening a long thread costs, and what part of it comes only once a launch (#2120, #1702). Measuring branch only.
# One build, one runner, one iPhone 16 Pro Max, the arms taking turns from a cold launch. Usage:
#   sh apps/ios/Scripts/open-why.sh <report folder> <rounds> <minutes to stop starting rounds at>
set -u
start=$(date +%s)
out=$1; rounds=$2; limit=$3
mkdir -p "$out"
root=$(git rev-parse --show-toplevel)
git -C "$root" log -1 --format='%H %s' | tee "$out/source.txt"
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
device=$(xcrun simctl create "Sotto Open Why" "$1" "$2")
trap 'xcrun simctl shutdown "$device" >/dev/null 2>&1; xcrun simctl delete "$device" >/dev/null 2>&1' EXIT HUP INT TERM
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
xcrun simctl status_bar "$device" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100

optimized="SWIFT_OPTIMIZATION_LEVEL=-O SWIFT_COMPILATION_MODE=wholemodule GCC_OPTIMIZATION_LEVEL=s ENABLE_PREVIEWS=NO ENABLE_DEBUG_DYLIB=NO ENABLE_TESTABILITY=NO"
# shellcheck disable=SC2086
(cd "$root/apps/ios" && xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
    -destination "platform=iOS Simulator,id=$device" -derivedDataPath .build-bench \
    $optimized ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build) > "$out/build.log" 2>&1 \
    || { tail -60 "$out/build.log"; echo "It did not build."; exit 1; }
xcrun simctl install "$device" "$root/apps/ios/.build-bench/Build/Products/Debug-iphonesimulator/Sotto.app"
xcrun simctl launch "$device" com.millzach.sotto.ios --ui-fixture >/dev/null || true
sleep 8

# One journey from a cold launch: journey <report> <seconds> [arguments for the app]
journey() {
    report=$1; seconds=$2; shift 2
    rm -f "$report"
    # The sync arm: if SwiftUI's comparison waits on AttributeGraph reading a type's layout on a queue of its own, this
    # has it read the layout when asked.
    if [ -n "${ag_async:-}" ]; then export SIMCTL_CHILD_AG_ASYNC_LAYOUTS="$ag_async"; else unset SIMCTL_CHILD_AG_ASYNC_LAYOUTS; fi
    xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
    sleep 2
    SIMCTL_CHILD_SOTTO_BENCH_FILE="$report" xcrun simctl launch "$device" com.millzach.sotto.ios \
        --ui-fixture --reset-ui-preferences --bench-threads 300 --bench-turns 200 --bench-chunks 200 --bench-journey open \
        "$@" -AppleLanguages '(en)' -AppleLocale en_US >/dev/null
    outcome=timed-out
    for _ in $(seq 1 "$seconds"); do
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
        base) ag_async=; journey "$2" "$3" ;;
        keep) ag_async=; journey "$2" "$3" --bench-keep-list ;;
        sync) ag_async=0; journey "$2" "$3" ;;
    esac
}

# Whether this runtime's AttributeGraph reads the setting the sync arm uses, and what else it reads.
runtime_root=$(python3 - "$out" "$2" <<'PY'
import json, sys
from pathlib import Path
runtimes = json.loads((Path(sys.argv[1]) / 'runtimes.json').read_text())['runtimes']
print(next(r['runtimeRoot'] for r in runtimes if r['identifier'] == sys.argv[2]))
PY
)
{
    echo "$runtime_root"
    find "$runtime_root/System/Library/PrivateFrameworks/AttributeGraph.framework" -type f -maxdepth 2 2>/dev/null \
        | while read -r file; do LC_ALL=C grep -a -o 'AG_[A-Z_]*' "$file" 2>/dev/null; done | sort -u
    find "$runtime_root/../../../../Caches/dyld" /Library/Developer/CoreSimulator/Caches/dyld -type f -name 'dyld_sim_shared_cache_*' 2>/dev/null \
        | while read -r file; do echo "$file"; LC_ALL=C grep -a -o 'AG_[A-Z_]\{3,\}' "$file" 2>/dev/null | sort -u; done
} > "$out/ag-settings.txt" 2>&1 || true

round=1
while [ "$round" -le "$rounds" ]; do
    if [ $(( ($(date +%s) - start) / 60 )) -ge "$limit" ]; then echo "Stopped before round $round: past $limit minutes."; break; fi
    case $((round % 3)) in
        1) order="base keep sync" ;;
        2) order="sync base keep" ;;
        0) order="keep sync base" ;;
    esac
    for side in $order; do
        for run in 1 2; do arm "$side" "$out/$side-$round-$run.json" 180; done
    done
    # A journey that can't finish would spend the whole run failing: stop after the first round if none did.
    if [ "$round" = 1 ] && ! grep -lq '"phase":"finished"' "$out"/*-1-*.json; then
        echo "No journey of the first round finished."
        for report in "$out"/*-1-1.json; do python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sys.argv[1], d["phase"], d["marks"])' "$report"; done
        exit 1
    fi
    round=$((round + 1))
done

# Where the main thread went, named while the build's images are installed. The sampled journeys aren't timed.
ag_async=
sampled() {
    name=$1; shift
    journey "$out/sampled-$name.json" 300 --bench-sample "$out/sampled-$name.samples.txt" "$@"
    [ -f "$out/sampled-$name.samples.txt" ] && python3 "$root/apps/ios/Scripts/bench-sample.py" "$out/sampled-$name.samples.txt" > "$out/trace-$name.md" 2> "$out/trace-$name.log"
}
sampled base-1
sampled base-2
sampled turns1-1 --bench-open-turns 1
xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
