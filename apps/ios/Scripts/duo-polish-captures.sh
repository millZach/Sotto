#!/bin/sh
# Throwaway: on the Duo capture branches only, never merged. Builds the app for testing on an iPhone Duo simulator,
# opens its inner screen with the posture tool from the tag prototype/iphone-duo-layout, and runs the capture-only
# DuoCaptureTests (before and after alike) and, where the branch has them, DuoJourneyTests; held sideways, then upright
# where the posture tool can turn the screen. Keeps every screenshot and the logs.
set -u
cd "$(dirname "$0")/.."
root=.build-duo
out=$root/out
mkdir -p "$out" "$root/tool"

# The capture-only tests join the UI test target here, so main's project needs nothing committed for them.
python3 - <<'PY'
from pathlib import Path
p = Path('Sotto.xcodeproj/project.pbxproj')
s = p.read_text()
if 'DuoCaptureTests.swift' not in s:
    ref, build = '0000000000000000000001F4', '0000000000000000000001F5'
    anchor = ' 000000000000000000000103 = {isa = PBXBuildFile; fileRef = 000000000000000000000102; };\n'
    assert anchor in s
    s = s.replace(anchor, anchor + f' {ref} = {{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = DuoCaptureTests.swift; sourceTree = "<group>"; }};\n {build} = {{isa = PBXBuildFile; fileRef = {ref}; }};\n', 1)
    s = s.replace('children = (000000000000000000000102,', f'children = (000000000000000000000102,{ref},', 1)
    s = s.replace('files = (000000000000000000000103,', f'files = (000000000000000000000103,{build},', 1)
    p.write_text(s)
print('capture tests in the project')
PY

xcrun simctl list runtimes --json > "$root/runtimes.json"
xcrun simctl list devicetypes --json > "$root/devicetypes.json"
python3 - <<'PY' > "$root/device.tsv"
import json
from pathlib import Path
runtimes = json.loads(Path('.build-duo/runtimes.json').read_text())['runtimes']
runtime = max((r for r in runtimes if r.get('isAvailable') and r['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-')),
              key=lambda r: tuple(map(int, r['version'].split('.'))))
types = json.loads(Path('.build-duo/devicetypes.json').read_text())['devicetypes']
duo = next(d for d in types if 'Duo' in d['name'])
print(duo['identifier'], runtime['identifier'], duo['name'], runtime['version'], sep='\t')
PY
tee "$out/device.tsv" < "$root/device.tsv"
type=$(cut -f1 "$root/device.tsv"); runtime=$(cut -f2 "$root/device.tsv")
id=$(xcrun simctl create "Duo polish" "$type" "$runtime")
cleanup() { xcrun simctl shutdown "$id" >/dev/null 2>&1 || true; xcrun simctl delete "$id" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM
xcrun simctl boot "$id"
xcrun simctl bootstatus "$id" -b >/dev/null
xcrun simctl status_bar "$id" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100 || true

xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
    -destination "platform=iOS Simulator,id=$id" -derivedDataPath .build-native \
    ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build-for-testing > "$out/build.log" 2>&1
status=$?
grep -E "error:" "$out/build.log" | head -80
[ "$status" -eq 0 ] || { tail -60 "$out/build.log"; exit "$status"; }
app=.build-native/Build/Products/Debug-iphonesimulator/Sotto.app

git show prototype/iphone-duo-layout:apps/ios/Prototypes/duo/posture.m > "$root/tool/posture.m"
git show prototype/iphone-duo-layout:apps/ios/Prototypes/duo/posture-entitlements.plist > "$root/tool/posture-entitlements.plist"
xcrun -sdk iphonesimulator clang -arch arm64 -mios-simulator-version-min=17.0 -fobjc-arc -framework Foundation \
    "$root/tool/posture.m" -o "$root/tool/posture" -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements \
    -Xlinker "$root/tool/posture-entitlements.plist" 2>/dev/null
codesign -f -s - "$root/tool/posture" 2>/dev/null || true
xcrun simctl spawn "$id" "$root/tool/posture" -position=open -duration=0.3 -wait | tee "$out/posture.txt"
sleep 3
xcrun simctl install "$id" "$app"
xcrun simctl launch "$id" com.millzach.sotto.ios --ui-fixture --ui-still --ui-watcher >/dev/null || true
sleep 8
xcrun simctl io "$id" screenshot --display=3 "$out/raw-open-threads.png" >/dev/null 2>&1 || true
xcrun simctl terminate "$id" com.millzach.sotto.ios >/dev/null 2>&1 || true

# XCTest's screenshots on the Duo show its dark cover screen, so the host takes the inner screen's pictures: frames
# about every second while tests run, and the tests print "DUO-SHOT name time" at each moment worth a picture.
mkdir -p "$root/frames" "$out/shots"
grab() {
    while [ -f "$root/grabbing" ]; do
        t=$(python3 -c 'import time; print(f"{time.time():.2f}")')
        xcrun simctl io "$id" screenshot --display=3 "$root/frames/$t.png" >/dev/null 2>&1 || true
        sleep 0.4
    done
}
run_tests() {
    name=$1; shift
    touch "$root/grabbing"; grab & grabber=$!
    xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator \
        -destination "platform=iOS Simulator,id=$id" -derivedDataPath .build-native -resultBundlePath "$root/$name.xcresult" \
        -parallel-testing-enabled NO "$@" ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO test-without-building > "$out/$name.log" 2>&1
    code=$?
    rm -f "$root/grabbing"; wait $grabber 2>/dev/null
    grep -E "Test Case|error:|skipped" "$out/$name.log" | head -40
    python3 - "$name" <<'PY'
import re, shutil, sys
from pathlib import Path
name = sys.argv[1]
root = Path('.build-duo'); out = root / 'out'
frames = sorted((float(f.stem), f) for f in (root / 'frames').glob('*.png'))
marks = re.findall(r'DUO-SHOT (\S+) ([0-9.]+)', (out / f'{name}.log').read_text(errors='replace'))
seen = set()
for shot, at in marks:
    if shot in seen: continue
    seen.add(shot)
    at = float(at)
    near = [(abs(t - (at + 1.6)), f) for t, f in frames if at + 0.7 <= t <= at + 2.9]
    if not near:
        print(f'{shot}: no frame'); continue
    shutil.copy(min(near)[1], out / 'shots' / f'{name}-{shot}.png')
    print(f'{shot}: kept')
PY
    return $code
}
journeys=''
[ -f Tests/SottoUITests/DuoJourneyTests.swift ] && journeys=-only-testing:SottoUITests/DuoJourneyTests
status=0
run_tests sideways-captures -only-testing:SottoUITests/DuoCaptureTests || true
[ -n "$journeys" ] && { run_tests sideways-journeys $journeys || status=1; }

# Upright: try the argument names the posture tool's parser may know, dry, and use the first that sets an orientation.
chosen=''
for arg in -orientation=1 -orientation=portrait -orientation=2 -orientation=3 -orientation=4 -orient=1 -interfaceOrientation=1 -displayOrientation=1 -rotation=90; do
    line=$(SIMCTL_CHILD_DRY=1 xcrun simctl spawn "$id" "$root/tool/posture" -position=open -duration=0.3 $arg 2>&1 | tr '\n' ' ')
    echo "$arg -> $line" >> "$out/posture.txt"
    case "$line" in *"err=nil"*) case "$line" in *"orient=0 "*) ;; *) [ -z "$chosen" ] && chosen=$arg ;; esac ;; esac
done
echo "chosen orientation argument: ${chosen:-none}" | tee -a "$out/posture.txt"
if [ -n "$chosen" ]; then
    xcrun simctl spawn "$id" "$root/tool/posture" -position=open -duration=0.3 -wait $chosen | tee -a "$out/posture.txt"
    sleep 3
    xcrun simctl launch "$id" com.millzach.sotto.ios --ui-fixture --ui-still --ui-watcher >/dev/null || true
    sleep 8
    xcrun simctl io "$id" screenshot --display=3 "$out/raw-upright-threads.png" >/dev/null 2>&1 || true
    xcrun simctl terminate "$id" com.millzach.sotto.ios >/dev/null 2>&1 || true
    run_tests upright-captures -only-testing:SottoUITests/DuoCaptureTests || true
fi
[ -n "$journeys" ] && { run_tests upright-journeys $journeys || status=1; }
# The page's top edge, read from the pictures: how light the top rows are against the rows a little lower down.
python3 - <<'PY' | tee "$out/top-edge.txt"
import struct, zlib
from pathlib import Path
def rows(path, ys):
    data = path.read_bytes(); pos = 8; w = h = 0; idat = b''; ct = 6
    while pos < len(data):
        n = struct.unpack('>I', data[pos:pos+4])[0]; kind = data[pos+4:pos+8]; body = data[pos+8:pos+8+n]; pos += 12 + n
        if kind == b'IHDR': w, h, bd, ct = struct.unpack('>IIBB', body[:10])
        elif kind == b'IDAT': idat += body
    bpp = 4 if ct == 6 else 3; raw = zlib.decompress(idat); stride = w * bpp; prev = bytearray(stride); out = {}
    for y in range(max(ys) + 1):
        f = raw[y * (stride + 1)]; line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0; b = prev[i]; c = prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        if y in ys:
            xs = range(w // 4, w * 3 // 4, 8)
            out[y] = sum((0.2126 * line[x*bpp] + 0.7152 * line[x*bpp+1] + 0.0722 * line[x*bpp+2]) / 255 for x in xs) / len(xs)
    return out
for f in sorted(Path('.build-duo/out/shots').glob('*.png')):
    try:
        r = rows(f, [6, 240])
        print(f'{f.name}: top {r[6]:.3f}, lower {r[240]:.3f}')
    except Exception as e:
        print(f'{f.name}: {e}')
PY
exit "$status"
