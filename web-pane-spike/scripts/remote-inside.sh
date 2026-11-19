#!/usr/bin/env bash
# Runs inside the owned nested Hyprland: the window process with CEF in a helper it starts and ends.
# Usage: remote-inside.sh <run-dir> <cycles> <hold-seconds>
set -euo pipefail
RUN="$1"; CYCLES="$2"; HOLD="$3"; LIVE=wayland-1
[ "${WAYLAND_DISPLAY:-}" != "$LIVE" ] || { echo "refusing the live display"; exit 1; }
DIST="${DIST:-$HOME/.cache/sotto-tmp/wp-dist-embed}"; VP="$HOME/.cache/sotto-tmp/vpointer"
mkdir -p "$RUN/home/.config" "$RUN/home/.cache"
hyprctl dismissnotify >/dev/null 2>&1 || true
( cd "$DIST" && env -u DBUS_SESSION_BUS_ADDRESS HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/home/.config" XDG_CACHE_HOME="$RUN/home/.cache" \
    WP_MODE=embed WP_REMOTE=1 WP_REMOTE_CYCLES="$CYCLES" WP_REMOTE_HOLD_S="$HOLD" WP_VIEW="${WP_VIEW:-}" WP_RUN_DIR="$RUN" WP_EMBED_SECONDS="${SECONDS_TOTAL:-40}" \
    WP_SWITCHES="ozone-platform=wayland" ./webpane > "$RUN/stdout.log" 2> "$RUN/stderr.log" ) &
APP=$!
if [ "$CYCLES" = 1 ]; then
  sleep 6
  hyprctl clients -j > "$RUN/clients.json"
  read -r X Y W H < <(python3 -c "
import json;c=[c for c in json.load(open('$RUN/clients.json')) if 'web pane spike' in c.get('title','')][0];print(c['at'][0],c['at'][1],c['size'][0],c['size'][1])")
  MON=$(hyprctl monitors -j | python3 -c "import json,sys;m=json.load(sys.stdin)[0];print(m['width'],m['height'])")
  grim -g "$X,$Y ${W}x$H" "$RUN/1-loaded.png"
  FIFO="$RUN/pointer.fifo"; mkfifo "$FIFO"; "$VP" "$LIVE" $MON < "$FIFO" & VPID=$!
  exec 9> "$FIFO"; p() { echo "$1" >&9; }
  p "move $((X + 120)) $((Y + 200))"; p "sleep 300"; p "move $((X + 300)) $((Y + 76))"; p "sleep 300"; p down; p "sleep 60"; p up; p "sleep 400"
  sleep 1.2; wtype -d 40 "across the socket"; sleep 0.5
  grim -g "$X,$Y ${W}x$H" "$RUN/2-typed.png"
  exec 9>&-; wait $VPID || true
fi
wait $APP || true
echo "remote done"
