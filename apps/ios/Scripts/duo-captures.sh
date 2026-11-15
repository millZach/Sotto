#!/bin/sh
# The Duo design captures: builds the app for testing on an iPhone Duo simulator and runs DuoCaptureTests folded, then
# unfolded held sideways, then unfolded upright (the Threads page, a thread and Watcher only). XCTest's
# own screenshots on the Duo show only the cover screen, so this script takes the pictures from the host: it grabs a frame
# about every half second while the tests run and keeps the one nearest each `DUO-SHOT` mark, and records each posture's
# run as a video. Each `DUO-CLIP` pair is cut from it here where the runner has ffmpeg, and otherwise on any computer by
# `duo-captures-collect.py --cut <the downloaded folder>`.
# Everything lands in apps/ios/.build-duo/out: shots/*.png, clips/*, videos/*, the logs, and manifest.json.
# Usage: duo-captures.sh [folded,sideways,upright]   (all three when left out)
set -u
cd "$(dirname "$0")/.."
postures=${1:-folded,sideways,upright}
root=.build-duo
out=$root/out
rm -rf "$root"
mkdir -p "$out/shots" "$out/clips" "$out/videos" "$root/tool" "$root/frames"

xcrun simctl list runtimes --json > "$root/runtimes.json"
xcrun simctl list devicetypes --json > "$root/devicetypes.json"
# Every iOS runtime, newest first, beside the Duo's device type. Not every runtime on the runner can host the Duo (on
# November 8, 2026 the xcode-27 runner's iOS 27.2 could not), so the first that creates one is used.
python3 - <<'PY' > "$root/device.tsv"
import json
from pathlib import Path
runtimes = json.loads(Path('.build-duo/runtimes.json').read_text())['runtimes']
types = json.loads(Path('.build-duo/devicetypes.json').read_text())['devicetypes']
duo = next(d for d in types if 'Duo' in d['name'])
ios = [r for r in runtimes if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-')]
for r in sorted(ios, key=lambda r: tuple(map(int, r['version'].split('.'))), reverse=True):
    print(duo['identifier'], r['identifier'], duo['name'], r['version'], sep='\t')
PY
cp "$root/device.tsv" "$out/runtimes-tried.tsv"; cp "$root/runtimes.json" "$out/runtimes.json"
id=''
tab=$(printf '\t')
while IFS="$tab" read -r type runtime name version; do
    if id=$(xcrun simctl create "Sotto Duo captures" "$type" "$runtime" 2>>"$out/runtimes-tried.tsv"); then
        printf '%s\t%s\t%s\n' "$name" "$version" "$runtime" | tee "$out/device.tsv"
        break
    fi
    id=''
done < "$root/device.tsv"
[ -n "$id" ] || { echo "No iOS runtime on this runner could create an iPhone Duo"; cat "$out/runtimes-tried.tsv"; exit 1; }
recorder=''
cleanup() {
    [ -n "$recorder" ] && kill -INT "$recorder" 2>/dev/null
    rm -f "$root/grabbing"
    xcrun simctl shutdown "$id" >/dev/null 2>&1 || true
    xcrun simctl delete "$id" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
xcrun simctl boot "$id"
xcrun simctl bootstatus "$id" -b >/dev/null
xcrun simctl status_bar "$id" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100 || true
xcrun simctl io "$id" enumerate > "$out/displays.txt" 2>&1 || true

xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
    -destination "platform=iOS Simulator,id=$id" -derivedDataPath .build-native \
    ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build-for-testing > "$out/build.log" 2>&1
status=$?
grep -E "error:" "$out/build.log" | head -80
[ "$status" -eq 0 ] || { tail -60 "$out/build.log"; exit "$status"; }
app=.build-native/Build/Products/Debug-iphonesimulator/Sotto.app
xcrun simctl install "$id" "$app"

# The posture tool opens the Duo's inner screen (Scripts/duo-posture, from the tag prototype/iphone-duo-layout).
xcrun -sdk iphonesimulator clang -arch arm64 -mios-simulator-version-min=17.0 -fobjc-arc -framework Foundation \
    Scripts/duo-posture/posture.m -o "$root/tool/posture" -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements \
    -Xlinker Scripts/duo-posture/posture-entitlements.plist 2>"$out/posture-build.txt"
codesign -f -s - "$root/tool/posture" 2>/dev/null || true

# The cover screen is display 1 and the inner screen display 3; a call that names no display fails on the Duo.
display_for() { [ "$1" = folded ] && echo '--display=1' || echo '--display=3'; }

# A first picture of each display with the app open, so a run that lands on the wrong screen says so.
probe() {
    xcrun simctl launch "$id" com.millzach.sotto.ios --ui-fixture --ui-still --ui-watcher >/dev/null 2>&1 || true
    sleep 8
    for d in 1 2 3; do xcrun simctl io "$id" screenshot --display=$d "$out/probe-$1-display$d.png" >/dev/null 2>&1 || true; done
    xcrun simctl terminate "$id" com.millzach.sotto.ios >/dev/null 2>&1 || true
}

grab() {
    display=$1
    while [ -f "$root/grabbing" ]; do
        t=$(python3 -c 'import time; print(f"{time.time():.2f}")')
        xcrun simctl io "$id" screenshot $display "$root/frames/$t.png" >/dev/null 2>&1 || true
        sleep 0.3
    done
}

run_posture() {
    posture=$1
    display=$(display_for "$posture")
    probe "$posture"
    rm -f "$root/frames"/*.png
    # The video of this posture's run; its start time places each clip in it.
    python3 -c 'import time; print(f"{time.time():.2f}")' > "$out/videos/$posture.start"
    xcrun simctl io "$id" recordVideo --codec=h264 --force $display "$out/videos/$posture.mov" > "$out/videos/$posture.log" 2>&1 &
    recorder=$!
    sleep 2
    touch "$root/grabbing"; grab "$display" & grabber=$!
    # Upright, only the pages whose top and rail it changes: the Threads page, a thread and Watcher.
    if [ "$posture" = upright ]; then
        set -- -only-testing:SottoUITests/DuoCaptureTests/testThreadsPage -only-testing:SottoUITests/DuoCaptureTests/testThreadReading -only-testing:SottoUITests/DuoCaptureTests/testWatcher
    else
        set -- -only-testing:SottoUITests/DuoCaptureTests
    fi
    TEST_RUNNER_SOTTO_DUO_POSTURE=$posture xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
        -destination "platform=iOS Simulator,id=$id" -derivedDataPath .build-native -resultBundlePath "$root/$posture.xcresult" \
        -parallel-testing-enabled NO "$@" ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO \
        test-without-building > "$out/$posture.log" 2>&1
    rm -f "$root/grabbing"; wait "$grabber" 2>/dev/null
    kill -INT "$recorder" 2>/dev/null; wait "$recorder" 2>/dev/null; recorder=''
    grep -E "Test Case|error:|skipped" "$out/$posture.log" | head -40
    python3 Scripts/duo-captures-collect.py "$posture"
}

# Upright: the posture tool opens the inner screen, then swaps it again with its orientation field set to 3, which turns
# it upright (November 10, 2026; 1, 2 and 4 leave it sideways, and XCUIDevice, `--ui-orientation` and Simulator.app's
# rotation do not reach the inner screen). A picture of it taller than wide confirms the turn.
turn_upright() {
    xcrun simctl spawn "$id" "$root/tool/posture" -position=open -duration=0.3 -wait | tee -a "$out/posture.txt"
    sleep 4
    SIMCTL_CHILD_ORIENT=3 xcrun simctl spawn "$id" "$root/tool/posture" -position=open -duration=0.3 -wait | tee -a "$out/posture.txt"
    sleep 4
    xcrun simctl io "$id" screenshot --display=3 "$root/upright-check.png" >/dev/null 2>&1 || return 1
    w=$(sips -g pixelWidth "$root/upright-check.png" | awk '/pixelWidth/ {print $2}')
    h=$(sips -g pixelHeight "$root/upright-check.png" | awk '/pixelHeight/ {print $2}')
    echo "Inner screen after the turn: ${w}x${h}"
    [ "${h:-0}" -gt "${w:-0}" ]
}

for posture in folded sideways upright; do
    case ",$postures," in *",$posture,"*) ;; *) continue ;; esac
    if [ "$posture" = sideways ]; then
        xcrun simctl spawn "$id" "$root/tool/posture" -position=open -duration=0.3 -wait | tee -a "$out/posture.txt"
        sleep 4
    fi
    if [ "$posture" = upright ]; then
        turn_upright || { echo "The inner screen did not turn upright, so upright is skipped"; continue; }
    fi
    run_posture "$posture"
done
python3 Scripts/duo-captures-collect.py --manifest
exit 0
