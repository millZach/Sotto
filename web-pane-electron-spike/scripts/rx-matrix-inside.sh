#!/usr/bin/env bash
# Runs inside the owned nested Hyprland: receiver-inside.sh for each row of rx-configs.txt. Usage: rx-matrix-inside.sh <root>
set -uo pipefail
ROOT="$1"; HERE="$(cd "$(dirname "$0")/.." && pwd)"
while read -r ver name fmt switches; do
  [ -z "$ver" ] || [ "${ver:0:1}" = "#" ] && continue
  [ -n "${ONLY:-}" ] && [[ ! " $ONLY " =~ " $ver/$name " ]] && continue
  RUN="$ROOT/$ver-$name"; rm -rf "$RUN"
  if [ "$ver" = cef ]; then P=cef; DIST=/nonexistent; else P=electron; DIST="$HOME/.cache/sotto-electron/v$ver/dist"; fi
  WPE_PRODUCER=$P WPE_CEF="$HOME/.cache/sotto-tmp/wp-dist-embed" WPE_FORMAT=$fmt WPE_SWITCHES="$switches" WPE_HOLD_S="${HOLD:-6}" \
    "$HERE/scripts/receiver-inside.sh" "$RUN" "$DIST" > "$RUN.inside.log" 2>&1
  python3 -I "$HERE/scripts/rx_row.py" "$RUN" "$ver/$name"
done < "$HERE/scripts/rx-configs.txt"
