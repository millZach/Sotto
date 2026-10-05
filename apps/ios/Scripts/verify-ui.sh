#!/bin/sh
# Creates only disposable simulators and keeps results/screenshots beside the native build.
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build-ui
run_dir=$(mktemp -d .build-ui/run-XXXXXX)
xcrun simctl list runtimes --json > .build-ui/runtimes.json
xcrun simctl list devicetypes --json > .build-ui/devicetypes.json
xcrun simctl help ui > "$run_dir/simctl-ui-help.txt" 2>&1
python3 - <<'PY' > .build-ui/devices.tsv
import json
from pathlib import Path
runtimes = json.loads(Path('.build-ui/runtimes.json').read_text())['runtimes']
runtime = max((r for r in runtimes if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-')),
              key=lambda r: tuple(map(int, r['version'].split('.'))))
types = json.loads(Path('.build-ui/devicetypes.json').read_text())['devicetypes']
# Both are compatible with the iOS 26 runtime. SE exercises the 375-point width;
# Pro Max exercises a large phone without prescribing a screenshot pixel scale.
for slug, name in [('small', 'iPhone SE (3rd generation)'), ('large', 'iPhone 16 Pro Max')]:
    device = next(d for d in types if d['name'] == name)
    print(slug, device['identifier'], runtime['identifier'], sep='\t')
PY
device_id=''
cleanup() {
    if [ -n "$device_id" ]; then
        xcrun simctl shutdown "$device_id" >/dev/null 2>&1 || true
        xcrun simctl delete "$device_id" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT HUP INT TERM
while IFS="$(printf '\t')" read -r size device_type runtime; do
    device_id=$(xcrun simctl create "Sotto Focus $size" "$device_type" "$runtime")
    xcrun simctl boot "$device_id"
    xcrun simctl bootstatus "$device_id" -b
    # Large-device screenshots also exercise the operating system's reduced-motion setting.
    if [ "$size" = large ]; then
        xcrun simctl spawn "$device_id" defaults write com.apple.Accessibility ReduceMotionEnabled -bool YES
        # Relaunch the simulator so SpringBoard applies the accessibility preference.
        xcrun simctl shutdown "$device_id"
        xcrun simctl boot "$device_id"
        xcrun simctl bootstatus "$device_id" -b
        xcrun simctl ui "$device_id" content_size accessibility-large
        xcrun simctl ui "$device_id" content_size > "$run_dir/large-content-size.txt"
        grep -qi 'accessibility-large' "$run_dir/large-content-size.txt"
    fi
    xcrun simctl status_bar "$device_id" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
    # Warm the freshly booted simulator: its first launch of the app can outlast XCTest's launch deadline and fail
    # whichever journey runs first. Install and launch the app verify.sh built once, with the fixture, then quit it.
    app=.build-native/Build/Products/Debug-iphonesimulator/Sotto.app
    if [ -d "$app" ]; then
        xcrun simctl install "$device_id" "$app" || true
        xcrun simctl launch "$device_id" com.millzach.sotto.ios --ui-fixture >/dev/null 2>&1 || true
        sleep 8
        xcrun simctl terminate "$device_id" com.millzach.sotto.ios >/dev/null 2>&1 || true
    fi
    result="$run_dir/$size.xcresult"
    status=0
    xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
        -destination "platform=iOS Simulator,id=$device_id" -derivedDataPath .build-native \
        -resultBundlePath "$result" -parallel-testing-enabled NO ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO test || status=$?
    if [ -d "$result" ]; then
        xcrun xcresulttool export attachments --path "$result" --output-path "$run_dir/$size-attachments"
        xcrun xcresulttool get test-results summary --path "$result" > "$run_dir/$size-summary.json"
    fi
    cleanup
    device_id=''
    [ "$status" -eq 0 ] || exit "$status"
done < .build-ui/devices.tsv
