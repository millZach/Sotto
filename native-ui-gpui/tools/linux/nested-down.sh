#!/usr/bin/env bash
# Stops the two compositors nested-up.sh started (by PID, after checking each is ours) and removes their folders.
set -uo pipefail
ROOT=${1:?root}
source "$ROOT/env"
for pid in $NESTED_PIDS; do
  if tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | grep -q "Hyprland -c $ROOT/"; then kill "$pid"; fi
done
sleep 1
for sig in "$HYPRLAND_INSTANCE_SIGNATURE" "$NESTED_A_SIGNATURE"; do
  d=/run/user/1000/hypr/$sig
  [ -d "$d" ] && ! pgrep -f "$ROOT/" >/dev/null && rm -rf "$d"
done
rm -rf "$ROOT"
echo "stopped $NESTED_PIDS"
