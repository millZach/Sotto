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
rm -rf "$out/app" "$out/look" "$out/bench.xcresult" "$out/summary.json" "$out/summary.md"
mkdir -p "$out/app" "$out/look"

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

# The journey, five times: the app scrolls the list, opens the long thread, scrolls it and streams a reply into it by
# itself (Sotto/Bench.swift) and writes journey-<n>.json.
for run in 1 2 3 4 5; do
    journey "$out/app/journey-$run.json" 600 all
    echo "Journey $run: $outcome"
    [ "$outcome" = finished ] || status=1
done

# The long thread photographed at fixed distances above its end, twice, so a change can be held to the base's look
# (`bench-summary.py look`) and a photo that differs between two launches of one build is known not to be the change's.
for run in 1 2; do
    journey "$out/look/look-$run.json" 300 look
    echo "Look $run: $outcome"
done
xcrun simctl terminate "$device_id" com.millzach.sotto.ios >/dev/null 2>&1 || true

# With BENCH_TRACE=1, one more journey with the app's own sampler on (`--bench-sample`, BenchSampler in Bench.swift):
# Instruments could not record the simulator on GitHub's runners, attached, launched or recording the whole Mac.
# bench-sample.py names the sampled stacks with atos and ranks where the main thread's time went in the open, the long
# thread's scroll and the stream (trace.md). The traced journey's numbers are not summarized: sampling slows the app.
if [ "${BENCH_TRACE:-}" = 1 ]; then
    samples="$out/trace-samples.json"
    rm -f "$samples"
    journey "$out/app/trace-journey.json" 900 all --bench-sample "$samples"
    echo "Sampled journey: $outcome"
    if [ -f "$samples" ]; then
        python3 Scripts/bench-sample.py "$samples" > "$out/trace.md" 2> "$out/trace.log" || echo "The samples were not read (see trace.log)"
    fi
    xcrun simctl terminate "$device_id" com.millzach.sotto.ios >/dev/null 2>&1 || true
fi

# SottoCore's part of the same work, timed on this Mac, optimized.
SOTTO_IOS_BENCH=1 swift test -c release -Xswiftc -enable-testing --filter PhoneBenchTests > "$out/core.log" 2>&1 || { tail -40 "$out/core.log"; status=1; }
grep "IOS-CORE" "$out/core.log" || true

{ xcodebuild -version; git log -1 --format='%H %s'; } > "$out/source.txt" 2>&1 || true
python3 Scripts/bench-summary.py summarize "$out"
exit "$status"
