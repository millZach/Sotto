#!/bin/sh
# Throwaway: screenshots for the October 29, 2026 iPhone UI review, on chore/ios-ui-hillclimb-captures only and never
# merged. A small and a large iPhone, each at the default text size and at accessibility-large, each walked in dark and
# light by the capture-only tests at the end of FocusJourneyTests. Failures keep whatever was captured.
set -u
cd "$(dirname "$0")/.."
root=.build-hillclimb
out=$root/out
mkdir -p "$out" "$root/raw"
xcrun simctl list runtimes --json > "$root/runtimes.json"
xcrun simctl list devicetypes --json > "$root/devicetypes.json"
python3 - <<'PY' > "$root/devices.tsv"
import json
from pathlib import Path
runtimes = json.loads(Path('.build-hillclimb/runtimes.json').read_text())['runtimes']
runtime = max((r for r in runtimes if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-')),
              key=lambda r: tuple(map(int, r['version'].split('.'))))
supported = {d['identifier'] for d in runtime.get('supportedDeviceTypes', [])}
types = json.loads(Path('.build-hillclimb/devicetypes.json').read_text())['devicetypes']
def pick(names):
    for name in names:
        for d in types:
            if d['name'] == name and (not supported or d['identifier'] in supported):
                return d
    raise SystemExit('No device type among ' + ', '.join(names))
for slug, names in [('se', ['iPhone SE (3rd generation)']), ('promax', ['iPhone 17 Pro Max', 'iPhone 16 Pro Max'])]:
    d = pick(names)
    print(slug, d['identifier'], runtime['identifier'], d['name'], runtime['version'], sep='\t')
PY
cat "$root/devices.tsv"
cp "$root/devices.tsv" "$out/devices.tsv"

: > "$root/sims.txt"
while IFS="$(printf '\t')" read -r slug type runtime name version <&3; do
    echo "$slug $(xcrun simctl create "Hillclimb $slug" "$type" "$runtime")" >> "$root/sims.txt"
done 3< "$root/devices.tsv"
cleanup() {
    while read -r slug id <&3; do
        xcrun simctl shutdown "$id" >/dev/null 2>&1 || true
        xcrun simctl delete "$id" >/dev/null 2>&1 || true
    done 3< "$root/sims.txt"
}
trap cleanup EXIT HUP INT TERM

first=$(head -1 "$root/sims.txt" | cut -d' ' -f2)
xcrun simctl boot "$first"
xcrun simctl bootstatus "$first" -b
xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
    -destination "platform=iOS Simulator,id=$first" -derivedDataPath .build-native \
    ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build-for-testing || exit 1
app=.build-native/Build/Products/Debug-iphonesimulator/Sotto.app

while read -r slug id <&3; do
    xcrun simctl boot "$id" >/dev/null 2>&1 || true
    xcrun simctl bootstatus "$id" -b
    xcrun simctl status_bar "$id" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
    # Warm the fresh simulator, as verify-ui.sh does: a first launch can outlast XCTest's launch deadline.
    xcrun simctl install "$id" "$app" || true
    xcrun simctl launch "$id" com.millzach.sotto.ios --ui-fixture >/dev/null || true
    sleep 8
    xcrun simctl terminate "$id" com.millzach.sotto.ios >/dev/null 2>&1 || true
    for size in large accessibility-large; do
        xcrun simctl ui "$id" content_size "$size"
        config="$slug-$size"
        result="$root/$config.xcresult"
        started=$(date +%s)
        xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
            -destination "platform=iOS Simulator,id=$id" -derivedDataPath .build-native -resultBundlePath "$result" \
            -parallel-testing-enabled NO ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO \
            -only-testing:SottoUITests/FocusJourneyTests/testHillclimbCapturesDark \
            -only-testing:SottoUITests/FocusJourneyTests/testHillclimbCapturesLight \
            test-without-building || echo "Captures on $config reported failures; keeping what they took."
        echo "$config took $(( $(date +%s) - started )) seconds"
        [ -d "$result" ] || continue
        xcrun xcresulttool get test-results summary --path "$result" > "$out/$config-summary.json" || true
        xcrun xcresulttool export attachments --path "$result" --output-path "$root/raw/$config" || continue
        python3 - "$root/raw/$config" "$out/$config" <<'PY'
import json, re, shutil, sys
from pathlib import Path
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)
kept = 0
for test in json.loads((src / 'manifest.json').read_text()):
    for item in test.get('attachments', []):
        name = item.get('suggestedHumanReadableName') or ''
        exported = src / item['exportedFileName']
        if not name.startswith('hc-') or not exported.exists():
            continue
        stem = re.sub(r'[^A-Za-z0-9._-]', '-', name.split('_')[0])
        shutil.copy(exported, dst / (Path(stem).stem + exported.suffix))
        kept += 1
print(f'{dst.name}: {kept} captures')
PY
    done
done 3< "$root/sims.txt"
ls -R "$out" | head -400
