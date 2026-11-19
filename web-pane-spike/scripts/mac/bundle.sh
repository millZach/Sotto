#!/usr/bin/env bash
# Lays the spike out as a macOS app, the way CEF requires and cef-rs's bundle-cef-app does it: webpane.app with
# Chromium Embedded Framework.framework in Contents/Frameworks and five helper apps beside it ("webpane Helper",
# "(GPU)", "(Renderer)", "(Plugin)", "(Alerts)"). The helpers run the same binary; it tells them apart by --type.
# Nothing is signed beyond the linker's ad hoc signature (no identity is available, and none is looked for).
# Usage: bundle.sh <webpane binary> <CEF dir, holding the framework> <output folder>
set -euo pipefail
BIN="$1"; CEF="$2"; OUT="$3"
APP="$OUT/webpane.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$APP/Contents/Resources"
plist() { # <file> <executable> <identifier> <is-helper>
  cat > "$1" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>$2</string>
  <key>CFBundleIdentifier</key><string>$3</string>
  <key>CFBundleName</key><string>$2</string>
  <key>CFBundleDisplayName</key><string>$2</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleVersion</key><string>0.0.0</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  $( [ "$4" = 1 ] && echo '<key>LSUIElement</key><string>1</string>' )
</dict></plist>
PLIST
}
cp "$BIN" "$APP/Contents/MacOS/webpane"
plist "$APP/Contents/Info.plist" webpane org.sotto.webpane-spike 0
ditto "$CEF/Chromium Embedded Framework.framework" "$APP/Contents/Frameworks/Chromium Embedded Framework.framework"
for kind in "" " (GPU)" " (Renderer)" " (Plugin)" " (Alerts)"; do
  name="webpane Helper$kind"
  id="org.sotto.webpane-spike.helper$(echo "$kind" | tr -d ' ()' | tr '[:upper:]' '[:lower:]' | sed 's/^./.&/')"
  h="$APP/Contents/Frameworks/$name.app"
  mkdir -p "$h/Contents/MacOS"
  cp "$BIN" "$h/Contents/MacOS/$name"
  plist "$h/Contents/Info.plist" "$name" "$id" 1
done
echo "$APP"
