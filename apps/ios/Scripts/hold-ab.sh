#!/bin/sh
# One runner, one iPhone SE, the same journeys, with the Threads list's hold and without it, taking turns so a runner
# that slows down weighs on both sides. "Without" is this commit with TabViews.swift and Views.swift as main had them at
# the commit the hold is merged onto; nothing else in the app differs. Measuring branch only. Usage:
#   sh apps/ios/Scripts/hold-ab.sh <report folder> <rounds per side> <minutes to stop starting rounds at>
set -u
start=$(date +%s)
out=$1; rounds=$2; limit=$3
mkdir -p "$out"
root=$(git rev-parse --show-toplevel)
control="$RUNNER_TEMP/without-hold"
git worktree add --detach "$control" HEAD
git -C "$control" checkout d2d5b05f5 -- apps/ios/Sotto/TabViews.swift apps/ios/Sotto/Views.swift
git -C "$control" status --short | tee "$out/without-hold-source.txt"

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
print(next(d for d in types if d['name'] == 'iPhone SE (3rd generation)')['identifier'], runtime['identifier'])
PY
)
device=$(xcrun simctl create "Sotto Hold AB" "$1" "$2")
trap 'xcrun simctl shutdown "$device" >/dev/null 2>&1; xcrun simctl delete "$device" >/dev/null 2>&1' EXIT HUP INT TERM
xcrun simctl boot "$device"
xcrun simctl bootstatus "$device" -b
xcrun simctl status_bar "$device" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100

common="-project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator -derivedDataPath .build-ab -parallel-testing-enabled NO ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO"
dir() { if [ "$1" = with ]; then echo "$root/apps/ios"; else echo "$control/apps/ios"; fi; }
for side in with without; do
    # shellcheck disable=SC2086
    (cd "$(dir $side)" && xcodebuild $common -destination "platform=iOS Simulator,id=$device" build-for-testing) > "$out/build-$side.log" 2>&1 \
        || { tail -60 "$out/build-$side.log"; echo "The $side side did not build."; exit 1; }
done

# Warm the booted simulator, as verify-ui.sh does.
xcrun simctl install "$device" "$root/apps/ios/.build-ab/Build/Products/Debug-iphonesimulator/Sotto.app"
xcrun simctl launch "$device" com.millzach.sotto.ios --ui-fixture >/dev/null || true
sleep 8
xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true

T=SottoUITests/FocusJourneyTests
tests="-only-testing:$T/testHoldABSwitchToWatcher -only-testing:$T/testHoldABOpenThreadWithQuestion \
-only-testing:$T/testAnsweringAQuestionKeepsTheConversationAtItsEnd -only-testing:$T/testWatchersOwnTurnStopsFromItsBox \
-only-testing:$T/testWatchersPermissionsChangeFromItsBox -only-testing:$T/testWordsSelectedInAReplyAreAddedToThePrompt \
-only-testing:$T/testWatchAThreadFromItsPageAndStopWatchingFromWatched"
run() {
    side=$1; round=$2
    echo "$(date -u +%H:%MZ) round $round, $side the hold"
    result="$out/$side-$round.xcresult"
    # shellcheck disable=SC2086
    if (cd "$(dir $side)" && xcodebuild $common -destination "platform=iOS Simulator,id=$device" -resultBundlePath "$result" $tests test-without-building) > "$out/$side-$round.log" 2>&1; then
        rm -rf "$result"
    fi
    python3 "$root/apps/ios/Scripts/hold-ab-summary.py" "$out" | tee "$out/summary.md" | tail -1
}
round=1
while [ "$round" -le "$rounds" ] && [ $(( $(date +%s) - start )) -lt $(( limit * 60 )) ]; do
    if [ $(( round % 2 )) -eq 1 ]; then run with "$round"; run without "$round"; else run without "$round"; run with "$round"; fi
    round=$(( round + 1 ))
done
cat "$out/summary.md"
