#!/usr/bin/env bash
# Builds the signed release APK. The signing key lives outside the repository; every later build must
# use the same key, or Android refuses to install it over the copy already on a phone.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY_DIR="${SOTTO_ANDROID_KEY_DIR:-$HOME/.config/sotto-android}"
STORE="$KEY_DIR/release.jks"
PASS_FILE="$KEY_DIR/keystore.pass"
if [ ! -f "$STORE" ]; then
    mkdir -p "$KEY_DIR"; chmod 700 "$KEY_DIR"
    umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$PASS_FILE"
    keytool -genkeypair -keystore "$STORE" -alias sotto -keyalg RSA -keysize 3072 -validity 10000 \
        -dname "CN=Sotto Android" -storepass "$(cat "$PASS_FILE")" -keypass "$(cat "$PASS_FILE")"
fi
./gradlew :app:assembleRelease -PsottoKeystoreFile="$STORE" -PsottoKeystorePassword="$(cat "$PASS_FILE")" -PsottoKeyAlias=sotto
ls -l app/build/outputs/apk/release/app-release.apk
