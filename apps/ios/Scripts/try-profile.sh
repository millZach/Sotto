#!/bin/bash
# [DEBUG-9e1c] Scratch, measurement only: where a picture thread's ~190 ms of CPU per working update goes, on main.
# One optimized build. Three kinds of journey, all the pictures journey from a cold launch:
#   plain   the app's own numbers, and every thread's CPU read from outside twice inside working-end (ps -M), so the
#           main thread's share of the process's CPU is known
#   traced  the app's own main-thread sampler (--bench-sample, BenchSampler), its stacks named with atos on this Mac
#   sample  macOS's sample(1) on the app's process for 10 s inside working-end: every thread, named by thread
set -u
commit=$1
repo=$GITHUB_WORKSPACE
out=$repo/profile-out
scripts=$RUNNER_TEMP
mkdir -p "$out/journeys" "$out/apps"
cd "$repo"
optimized="SWIFT_OPTIMIZATION_LEVEL=-O SWIFT_COMPILATION_MODE=wholemodule GCC_OPTIMIZATION_LEVEL=s ENABLE_PREVIEWS=NO ENABLE_DEBUG_DYLIB=NO ENABLE_TESTABILITY=NO"
git checkout -q "$commit" || exit 1
cp apps/ios/Scripts/bench-sample.py "$scripts/bench-sample.py"
start=$SECONDS
(cd apps/ios && xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .build-profile $optimized ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build) > "$out/build.log" 2>&1 || { echo "Build failed"; grep -n "error:" "$out/build.log" | head -20; exit 1; }
echo "Built in $((SECONDS - start)) s"
cp -R "apps/ios/.build-profile/Build/Products/Debug-iphonesimulator/Sotto.app" "$out/apps/main.app"
sudo -n true && echo "sudo: yes" || echo "sudo: no"
runtime=$(xcrun simctl list runtimes --json | python3 -c "import json,sys; r=[x for x in json.load(sys.stdin)['runtimes'] if x.get('isAvailable') and x['identifier'].startswith('com.apple.CoreSimulator.SimRuntime.iOS-')]; print(max(r,key=lambda x:tuple(map(int,x['version'].split('.'))))['identifier'])")
large=$(xcrun simctl create "Profile large" "iPhone 16 Pro Max" "$runtime")
small=$(xcrun simctl create "Profile small" "iPhone SE (3rd generation)" "$runtime")
for device in "$large" "$small"; do
    xcrun simctl boot "$device"
    xcrun simctl bootstatus "$device" -b >/dev/null
    xcrun simctl status_bar "$device" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100 || true
    xcrun simctl install "$device" "$out/apps/main.app"
    xcrun simctl launch "$device" com.millzach.sotto.ios --ui-fixture >/dev/null; sleep 8; xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1
done
# Every thread's times, twice; ps -M with and without sudo, as either may be refused.
threads() { # pid, file
    { echo "== $(python3 -c 'import time; print(time.time())')"; ps -M -p "$1" 2>&1 || true; echo "== sudo"; sudo -n ps -M -p "$1" 2>&1 || true; } >> "$2"
}
journey() { # label, kind, device
    label=$1; kind=$2; device=$3
    report="$out/journeys/$label.json"
    rm -f "$report" "$report.done"
    xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1
    sleep 2
    extra=()
    [ "$kind" = traced ] && extra=(--bench-sample "$out/journeys/$label.samples.json")
    SIMCTL_CHILD_SOTTO_BENCH_FILE="$report" xcrun simctl launch "$device" com.millzach.sotto.ios \
        --ui-fixture --reset-ui-preferences --ui-pictures --bench-threads 30 --bench-turns 4 --bench-chunks 1 \
        --bench-journey pictures --bench-pictures full "${extra[@]}" -AppleLanguages '(en)' -AppleLocale en_US > "$out/launch.txt" 2>&1
    pid=$(sed -n 's/^com.millzach.sotto.ios: \([0-9][0-9]*\)$/\1/p' "$out/launch.txt")
    [ -n "$pid" ] || { sleep 1; pid=$(pgrep -n -f '/Sotto.app/Sotto' || true); }
    echo "$label pid=$pid" >> "$out/pids.txt"
    outcome=timed-out; start=$SECONDS; probed=0
    for _ in $(seq 1 1200); do
        if [ -f "$report" ]; then
            grep -q '"phase":"finger"' "$report" && [ ! -f "$report.done" ] && touch "$report.done"
            if [ "$probed" = 0 ] && grep -q '"phase":"working-end"' "$report" && [ -n "$pid" ]; then
                probed=1
                sleep 1
                case $kind in
                    plain) threads "$pid" "$out/journeys/$label.threads.txt"; sleep 10; threads "$pid" "$out/journeys/$label.threads.txt" ;;
                    sample) /usr/bin/sample "$pid" 10 1 -mayDie -file "$out/journeys/$label.sample.txt" > "$out/journeys/$label.sample.log" 2>&1
                            [ -s "$out/journeys/$label.sample.txt" ] || sudo -n /usr/bin/sample "$pid" 10 1 -mayDie -file "$out/journeys/$label.sample.txt" >> "$out/journeys/$label.sample.log" 2>&1 ;;
                esac
            fi
            if grep -q '"phase":"finished"' "$report"; then outcome=finished; break; fi
            if grep -q '"phase":"failed-' "$report"; then outcome=failed; break; fi
        fi
        sleep 0.5
    done
    # The sampler writes when the journey finishes; give it a moment, then name its stacks while the app is installed.
    if [ "$kind" = traced ]; then
        for _ in $(seq 1 30); do [ -f "$out/journeys/$label.samples.json" ] && break; sleep 1; done
        python3 "$scripts/name-stacks.py" "$scripts/bench-sample.py" "$out/journeys/$label.samples.json" "$out/journeys/$label.named.json" > "$out/journeys/$label.name.log" 2>&1 || echo "$label: naming failed"
        python3 "$scripts/bench-sample.py" "$out/journeys/$label.samples.json" > "$out/journeys/$label.trace.md" 2>> "$out/journeys/$label.name.log" || true
    fi
    echo "$label: $outcome in $((SECONDS - start)) s (probed=$probed, at $SECONDS s)" | tee -a "$out/summary.txt"
}
journey warm-large-1 plain "$large"
for kind in plain traced sample plain traced; do
    n=$(ls "$out/journeys" | grep -cE "^$kind-large-[0-9]+\.json$" || true)
    journey "$kind-large-$((n + 1))" "$kind" "$large"
done
xcrun simctl shutdown "$large" || true
for kind in plain traced sample traced; do
    if [ "$SECONDS" -gt 5400 ]; then echo "Out of time before small $kind" | tee -a "$out/summary.txt"; break; fi
    n=$(ls "$out/journeys" | grep -cE "^$kind-small-[0-9]+\.json$" || true)
    journey "$kind-small-$((n + 1))" "$kind" "$small"
done
xcrun simctl shutdown "$small" || true
rm -rf "$out/apps"
ls -la "$out/journeys"
echo "Total $SECONDS s"
