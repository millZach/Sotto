#!/usr/bin/env bash
# Puts the spike binary beside CEF's files, as an install would: libcef.so and its resources next to the executable.
set -euo pipefail
CEF_DIR="${CEF_DIR:-$HOME/.cache/sotto-cef/156.0.31/cef_linux_x86_64}"
TARGET="${CARGO_TARGET_DIR:-$HOME/.cache/sotto-cargo-target}/release/webpane"
DIST="${1:-$HOME/.cache/sotto-tmp/wp-dist}"
mkdir -p "$DIST"
for f in libcef.so libvk_swiftshader.so libvulkan.so.1 vk_swiftshader_icd.json icudtl.dat v8_context_snapshot.bin resources.pak chrome_100_percent.pak chrome_200_percent.pak locales chrome-sandbox; do
  ln -sfn "$CEF_DIR/$f" "$DIST/$f"
done
cp -f "$TARGET" "$DIST/webpane"
echo "$DIST"
