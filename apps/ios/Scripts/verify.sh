#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
swift test
xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .build-native CODE_SIGNING_ALLOWED=NO build
