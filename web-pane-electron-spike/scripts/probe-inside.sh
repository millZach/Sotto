#!/usr/bin/env bash
# Runs inside the owned nested Hyprland: the probe for each configuration in configs.txt.
# Usage: probe-inside.sh <electron> <run-root> [seconds]
set -uo pipefail
E="$1"; ROOT="$2"; SECS="${3:-8}"; HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ "${WAYLAND_DISPLAY:-}" != "wayland-1" ] || { echo "refusing the live display"; exit 1; }
# The nested compositor's own XWayland, never the live one.
XW=$(pgrep -P "$SOTTO_PACKAGE_NESTED_PID" -x Xwayland | head -1)
NDISPLAY=$(tr '\0' '\n' < /proc/$XW/cmdline | grep -m1 '^:[0-9]')
echo "nested XWayland pid=$XW display=$NDISPLAY"
while read -r name fmt shared args; do
  [ -z "$name" ] || [ "${name:0:1}" = "#" ] && continue
  [ -n "${ONLY:-}" ] && [[ ! " $ONLY " =~ " $name " ]] && continue
  rm -rf "$ROOT/$name"
  DISPLAY="$NDISPLAY" WPE_SHARED=$shared WPE_FORMAT=$fmt env -u DBUS_SESSION_BUS_ADDRESS python3 -I "$HERE/scripts/probe.py" "$E" "$HERE/helper" "$ROOT/$name" "$SECS" $args > /dev/null || echo "$name probe failed"
  python3 -I "$HERE/scripts/probe_row.py" "$ROOT/$name" "$name"
done < "$HERE/scripts/configs.txt"
