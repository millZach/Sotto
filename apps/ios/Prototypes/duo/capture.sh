#!/bin/sh
# Prototype only: captures Sotto on a headless iPhone Duo simulator, folded or unfolded, without Simulator.app.
# usage: capture.sh <device> <folded|open> <out.png> [app launch arguments...]
set -eu
here=$(cd "$(dirname "$0")" && pwd)
device=$1; posture=$2; out=$3; shift 3
tool="$here/.build/posture"
if [ ! -x "$tool" ]; then
    mkdir -p "$here/.build"
    # The posture call is SpringBoard's own display tool service; the simulator reads entitlements from this section.
    xcrun -sdk iphonesimulator clang -arch arm64 -mios-simulator-version-min=17.0 -fobjc-arc -framework Foundation \
        "$here/posture.m" -o "$tool" -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker "$here/posture-entitlements.plist"
    codesign -f -s - "$tool" 2>/dev/null
fi
if [ "$posture" = open ]; then position=open; display=3; else position=closed; display=1; fi
xcrun simctl spawn "$device" "$tool" -position=$position -duration=0.3 -wait >/dev/null
xcrun simctl terminate "$device" com.millzach.sotto.ios >/dev/null 2>&1 || true
xcrun simctl launch "$device" com.millzach.sotto.ios --ui-fixture --ui-still --ui-watcher "$@" >/dev/null
sleep "${WAIT:-6}"
xcrun simctl io "$device" screenshot --display=$display "$out" >/dev/null
