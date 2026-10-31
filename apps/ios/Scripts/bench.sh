#!/bin/sh
# The iPhone benchmarks (docs/perf/2026-10-31-iphone-benchmarks.md). Usage, on a Mac with Xcode:
#   sh apps/ios/Scripts/bench.sh <report folder>
# Builds the app optimized, runs PerformanceJourneyTests on one disposable simulator and SottoCore's timings, and writes
# summary.json and summary.md into the folder. `bench-summary.py compare <before> <after>` sets two folders side by side.
set -eu
cd "$(dirname "$0")/.."
mkdir -p "$1"
out=$(cd "$1" && pwd)
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
# XCTest's launch metric, five cold launches to the whole thread list.
# shellcheck disable=SC2086
TEST_RUNNER_SOTTO_BENCH_OUT="$out/app" xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
    -destination "platform=iOS Simulator,id=$device_id" -derivedDataPath .build-bench -resultBundlePath "$out/bench.xcresult" \
    -parallel-testing-enabled NO -only-testing:SottoUITests/PerformanceJourneyTests \
    $optimized ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO test-without-building > "$out/test.log" 2>&1 || status=$?
grep -E "measured \[|Test Case .*(passed|failed|skipped)|error:" "$out/test.log" || true

# The journey, five times, each from a cold launch with nothing else attached: the app scrolls the list, opens the long
# thread, scrolls it and streams a reply into it by itself (Sotto/Bench.swift) and writes journey-<n>.json.
for run in 1 2 3 4 5; do
    report="$out/app/journey-$run.json"
    rm -f "$report"
    xcrun simctl terminate "$device_id" com.millzach.sotto.ios >/dev/null 2>&1 || true
    sleep 2
    SIMCTL_CHILD_SOTTO_BENCH_FILE="$report" xcrun simctl launch "$device_id" com.millzach.sotto.ios \
        --ui-fixture --reset-ui-preferences --bench-threads 300 --bench-turns 200 --bench-chunks 200 --bench-journey all \
        -AppleLanguages '(en)' -AppleLocale en_US >/dev/null
    finished=no
    for _ in $(seq 1 600); do
        if [ -f "$report" ] && grep -q '"phase":"finished"' "$report"; then finished=yes; break; fi
        sleep 1
    done
    echo "Journey $run: finished=$finished"
    [ "$finished" = yes ] || status=1
done
xcrun simctl terminate "$device_id" com.millzach.sotto.ios >/dev/null 2>&1 || true

# SottoCore's part of the same work, timed on this Mac, optimized.
SOTTO_IOS_BENCH=1 swift test -c release -Xswiftc -enable-testing --filter PhoneBenchTests > "$out/core.log" 2>&1 || { tail -40 "$out/core.log"; status=1; }
grep "IOS-CORE" "$out/core.log" || true

{ xcodebuild -version; git log -1 --format='%H %s'; } > "$out/source.txt" 2>&1 || true
python3 Scripts/bench-summary.py summarize "$out"
exit "$status"
