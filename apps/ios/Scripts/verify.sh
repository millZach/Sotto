#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# The String Catalogs hold every key the code localizes, in every language (ADR-0123). The unit suite runs the same
# check on every pull request; here it saves a Mac build when a key is missing.
if command -v node >/dev/null 2>&1; then node Scripts/check-strings.mjs; fi
swift test
xcodebuild -project Sotto.xcodeproj -scheme Sotto -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath .build-native CODE_SIGNING_ALLOWED=NO build
