#!/usr/bin/env bash
# Runs inside the owned nested Hyprland: CEF's windowed mode with the winit window as its parent.
# Usage: child-inside.sh <run-dir> <x11|wayland>
set -euo pipefail
RUN="$1"; KIND="$2"; LIVE=wayland-1
[ "${WAYLAND_DISPLAY:-}" != "$LIVE" ] || { echo "refusing the live display"; exit 1; }
DIST="${DIST:-$HOME/.cache/sotto-tmp/wp-dist-embed}"
mkdir -p "$RUN/home/.config" "$RUN/home/.cache"
hyprctl dismissnotify >/dev/null 2>&1 || true
# The nested compositor's own XWayland display, learned from a process it starts.
hyprctl eval "hl.exec_cmd(\"sh -c 'echo \$DISPLAY > $RUN/xdisplay.txt'\")" >/dev/null; sleep 2
NESTED_X="$(cat "$RUN/xdisplay.txt" 2>/dev/null || true)"
echo "nested XWayland DISPLAY=${NESTED_X:-none} WAYLAND_DISPLAY=$WAYLAND_DISPLAY" > "$RUN/display.txt"
if [ "$KIND" = x11 ]; then UNSET="-u WAYLAND_DISPLAY DISPLAY=$NESTED_X"; OZ="ozone-platform=x11"; else UNSET=""; OZ="ozone-platform=wayland"; fi
( cd "$DIST" && env -u DBUS_SESSION_BUS_ADDRESS $UNSET HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/home/.config" XDG_CACHE_HOME="$RUN/home/.cache" \
    WP_MODE=child WP_RUN_DIR="$RUN" WP_EMBED_SECONDS=14 WP_SWITCHES="$OZ" ./webpane > "$RUN/stdout.log" 2> "$RUN/stderr.log" ) &
APP=$!
sleep 7
hyprctl clients -j > "$RUN/clients.json"
python3 -c "
import json;[print(c['class'],'|',c['title'],c['at'],c['size'],'xwayland' if c.get('xwayland') else 'wayland') for c in json.load(open('$RUN/clients.json'))]" | tee "$RUN/clients.txt"
grim "$RUN/screen.png"
wait $APP || true
echo "child done"
