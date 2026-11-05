#!/bin/sh
# The iPhone benchmarks (docs/perf/2026-10-31-iphone-benchmarks.md). Usage, on a Mac with Xcode:
#   sh apps/ios/Scripts/bench.sh <report folder>
# Builds the app optimized, runs PerformanceJourneyTests on one disposable simulator and SottoCore's timings, and writes
# summary.json and summary.md into the folder. `bench-summary.py compare <before> <after>` sets two folders side by side.
set -eu
cd "$(dirname "$0")/.."
mkdir -p "$1"
out=$(cd "$1" && pwd)
# A folder used before keeps nothing from that run: Xcode refuses an existing result bundle, and old reports would be
# summarized with the new ones.
rm -rf "$out/app"
mkdir -p "$out/app"

# One phone for every run, so a branch and main are measured on the same simulated hardware.
xcrun simctl list runtimes --json > "$out/runtimes.json"
xcrun simctl list devicetypes --json > "$out/devicetypes.json"
device=$(python3 - "$out" <<'PY'
import json, sys
from pathlib import Path
out = Path(sys.argv[1])
runtimes = json.loads((out / 'runtimes.json').read_text())['runtimes']
runtime = max((r for r in runtimes if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-')),
              key=lambda r: tuple(map(int, r['version'].split('.'))))
types = json.loads((out / 'devicetypes.json').read_text())['devicetypes']
device = next(d for d in types if d['name'] == 'iPhone 16 Pro Max')
print(device['identifier'], runtime['identifier'], runtime['version'])
PY
)
set -- $device
device_id=$(xcrun simctl create "Sotto Bench" "$1" "$2")
echo "Simulator: iPhone 16 Pro Max, iOS $3 ($device_id)"
cleanup() {
    xcrun simctl shutdown "$device_id" >/dev/null 2>&1 || true
    xcrun simctl delete "$device_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
xcrun simctl boot "$device_id"
xcrun simctl bootstatus "$device_id" -b
xcrun simctl status_bar "$device_id" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100

# The Debug configuration holds the UI fixture the benchmarks drive; it is built here as Release optimizes, without
# Xcode's preview stub, so what is timed is the code the App Store build runs.
optimized="SWIFT_OPTIMIZATION_LEVEL=-O SWIFT_COMPILATION_MODE=wholemodule GCC_OPTIMIZATION_LEVEL=s ENABLE_PREVIEWS=NO ENABLE_DEBUG_DYLIB=NO ENABLE_TESTABILITY=NO"
# shellcheck disable=SC2086
xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
    -destination "platform=iOS Simulator,id=$device_id" -derivedDataPath .build-bench \
    $optimized ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build-for-testing > "$out/build.log" 2>&1 || { tail -60 "$out/build.log"; exit 1; }

# A first launch outlasts the rest while the simulator settles; launch once and quit before measuring.
app=.build-bench/Build/Products/Debug-iphonesimulator/Sotto.app
xcrun simctl install "$device_id" "$app"
xcrun simctl launch "$device_id" com.millzach.sotto.ios --ui-fixture >/dev/null || true
sleep 8
xcrun simctl terminate "$device_id" com.millzach.sotto.ios >/dev/null 2>&1 || true

status=0
# One journey ($3, `all` or `look`) from a cold launch with nothing else attached, writing its report to $1 and waiting
# up to $2 seconds; any further arguments go to the app. Sets `outcome`: the app ends on `finished`, or on
# `failed-<why>` when a phase never got what it waited for.
journey() {
    report="$1"; limit="$2"; kind="$3"; shift 3
    rm -f "$report"
    xcrun simctl terminate "$device_id" com.millzach.sotto.ios >/dev/null 2>&1 || true
    sleep 2
    SIMCTL_CHILD_SOTTO_BENCH_FILE="$report" xcrun simctl launch "$device_id" com.millzach.sotto.ios \
        --ui-fixture --reset-ui-preferences --bench-threads 300 --bench-turns 200 --bench-chunks 200 --bench-journey "$kind" \
        "$@" -AppleLanguages '(en)' -AppleLocale en_US >/dev/null
    outcome=timed-out
    for _ in $(seq 1 "$limit"); do
        if [ -f "$report" ]; then
            if grep -q '"phase":"finished"' "$report"; then outcome=finished; break; fi
            if grep -q '"phase":"failed-' "$report"; then outcome=failed; break; fi
        fi
        sleep 1
    done
}

for round in 1 2 3; do
    for variant in whole lazy fixed chunks chunksfixed plain; do
        journey "$out/app/$variant-$round.json" 300 scroll --bench-list "$variant"
        echo "Round $round, $variant: $outcome"
    done
done
xcrun simctl terminate "$device_id" com.millzach.sotto.ios >/dev/null 2>&1 || true
python3 Scripts/bench-variants.py "$out/app"
