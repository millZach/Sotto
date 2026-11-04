#!/bin/sh
# What opening a long thread costs, and what part of it comes only once a launch (#2120, #1702). Measuring branch only.
# One build, one runner, one iPhone 16 Pro Max, from a cold launch: six journeys that say why the views above the list
# draw again, and what published on the model. Usage:
#   sh apps/ios/Scripts/open-why.sh <report folder>
set -u
out=$1
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
    xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
    sleep 2
    SIMCTL_CHILD_SOTTO_BENCH_FILE="$report" xcrun simctl launch --stdout="${report%.json}.txt" "$device" com.millzach.sotto.ios \
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
for run in 1 2 3 4 5 6; do journey "$out/why-$run.json" 180 --bench-why-bodies; done
xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
