#!/usr/bin/env bash
# Runs inside the owned nested Hyprland: the Rust window with the Electron helper it starts and ends.
# Captures the window, lists clients and layers while the helper runs, and with INPUT=1 clicks the page's text field
# and types into it through the nested compositor. Usage: receiver-inside.sh <run-dir> <electron-dist>
set -uo pipefail
RUN="$1"; DIST="$2"; LIVE=wayland-1; HERE="$(cd "$(dirname "$0")/.." && pwd)"
[ "${WAYLAND_DISPLAY:-}" != "$LIVE" ] || { echo "refusing the live display"; exit 1; }
VP="$HOME/.cache/sotto-tmp/vpointer"; BIN="${CARGO_TARGET_DIR:-$HOME/.cache/sotto-cargo-target}/release/wpe-receiver"
XW=$(pgrep -P "$SOTTO_PACKAGE_NESTED_PID" -x Xwayland | head -1); export DISPLAY=$(tr '\0' '\n' < /proc/$XW/cmdline | grep -m1 '^:[0-9]')
mkdir -p "$RUN"; hyprctl dismissnotify >/dev/null 2>&1 || true
[ "${KEEP_BUS:-0}" = 1 ] || UNSET="-u DBUS_SESSION_BUS_ADDRESS"
env ${UNSET:-} WPE_DIST="$DIST" WPE_APP="$HERE/helper" WPE_RUN_DIR="$RUN" "$BIN" > "$RUN/receiver.log" 2>&1 &
APP=$!
sleep "${SHOT_AFTER:-6}"
hyprctl clients -j > "$RUN/clients.json"; hyprctl layers -j > "$RUN/layers.json"
read -r X Y W H < <(python3 -c "
import json;c=[c for c in json.load(open('$RUN/clients.json')) if 'electron helper spike' in c.get('title','')][0];print(c['at'][0],c['at'][1],c['size'][0],c['size'][1])")
grim -g "$X,$Y ${W}x$H" "$RUN/1-window.png"
sleep 0.7; grim -g "$X,$Y ${W}x$H" "$RUN/1b-window.png"
if [ "${INPUT:-0}" = 1 ]; then
  MON=$(hyprctl monitors -j | python3 -c "import json,sys;m=json.load(sys.stdin)[0];print(m['width'],m['height'])")
  # The text field sits at page (20..320, 8..34); the page is drawn scaled into the rectangle (220, 48) .. (W-16, H-16).
  read -r PX PY < <(python3 -c "
w,h=$W,$H; rw,rh=w-236,h-64; vw,vh=map(int,'${WPE_VIEW:-1280x800}'.split('x'))
print($X+220+int(120*rw/vw), $Y+48+int(20*rh/vh))")
  FIFO="$RUN/pointer.fifo"; rm -f "$FIFO"; mkfifo "$FIFO"; "$VP" "$LIVE" $MON < "$FIFO" & VPID=$!
  exec 9> "$FIFO"; p() { echo "$1" >&9; }
  p "move $((X + 100)) $((Y + 300))"; p "sleep 300"; p "move $PX $PY"; p "sleep 300"; p down; p "sleep 60"; p up; p "sleep 400"
  sleep 1.5; wtype -d 40 "typed from rust"; sleep 1
  exec 9>&-; wait $VPID || true
  grim -g "$X,$Y ${W}x$H" "$RUN/2-typed.png"
fi
wait $APP; echo "receiver exit $?"
