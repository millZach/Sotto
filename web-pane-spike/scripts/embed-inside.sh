#!/usr/bin/env bash
# Runs inside the owned nested Hyprland (scripts/with-nested-hyprland.mjs): opens the embed window, takes captures,
# and drives the nested pointer and keyboard into it. Refuses the live display.
# Usage: embed-inside.sh <run-dir> <path: accelerated|software>
set -euo pipefail
RUN="$1"; PATHKIND="$2"; LIVE=wayland-1
[ "${WAYLAND_DISPLAY:-}" != "$LIVE" ] || { echo "refusing the live display"; exit 1; }
DIST="${DIST:-$HOME/.cache/sotto-tmp/wp-dist-embed}"; VP="$HOME/.cache/sotto-tmp/vpointer"
mkdir -p "$RUN/home/.config" "$RUN/home/.cache"
hyprctl dismissnotify >/dev/null 2>&1 || true
( cd "$DIST" && env -u DBUS_SESSION_BUS_ADDRESS HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/home/.config" XDG_CACHE_HOME="$RUN/home/.cache" \
    WP_MODE=embed WP_VIEW="${WP_VIEW:-}" WP_PATH="$PATHKIND" WP_RUN_DIR="$RUN" WP_EMBED_SECONDS="${SECONDS_TOTAL:-32}" WP_SWITCHES="ozone-platform=wayland;${WP_EXTRA:-}" \
    ./webpane > "$RUN/stdout.log" 2> "$RUN/stderr.log" ) &
APP=$!
sleep 6
hyprctl clients -j > "$RUN/clients.json"
read -r X Y W H < <(python3 -c "
import json;c=[c for c in json.load(open('$RUN/clients.json')) if 'web pane spike' in c.get('title','')][0];print(c['at'][0],c['at'][1],c['size'][0],c['size'][1])")
echo "window at $X,$Y ${W}x$H" | tee "$RUN/window.txt"
MON=$(hyprctl monitors -j | python3 -c "import json,sys;m=json.load(sys.stdin)[0];print(m['width'],m['height'])")
grim -g "$X,$Y ${W}x$H" "$RUN/1-loaded.png"
# The page's text field is at page (20..320, 8..34); the page starts at window (240, 56).
PX=$((X + 240 + 60)); PY=$((Y + 56 + 20))
# One virtual pointer for the whole run, fed through a pipe, with the keyboard (wtype) in between.
FIFO="$RUN/pointer.fifo"; mkfifo "$FIFO"
"$VP" "$LIVE" $MON < "$FIFO" & VPID=$!
exec 9> "$FIFO"
p() { echo "$1" >&9; }
p "move $((X + 120)) $((Y + 300))"; p "sleep 300"; p "move $PX $PY"; p "sleep 300"; p down; p "sleep 60"; p up; p "sleep 400"
sleep 1.2
wtype -d 40 "hello pane"
sleep 0.5
grim -g "$X,$Y ${W}x$H" "$RUN/2-typed.png"
# Wheel inside the page, then a click on the native sidebar: focus leaves the page, and typing stays native.
p "move $((X + 700)) $((Y + 300))"; p "sleep 200"; p "scroll 15"; p "sleep 100"; p "scroll 15"; p "sleep 400"
p "move $((X + 120)) $((Y + 300))"; p "sleep 200"; p down; p "sleep 60"; p up; p "sleep 300"
sleep 2
wtype "zz"
exec 9>&-; wait $VPID || true
sleep 0.5
grim -g "$X,$Y ${W}x$H" "$RUN/3-native-focus.png"
# CPU of the whole process tree over 10 s of an animating page.
tree() { local p=$1; echo $p; for c in $(cat /proc/$p/task/*/children 2>/dev/null); do tree $c; done; }
cpu() { local t=0; for p in $(tree $APP); do s=$(awk '{print $14+$15}' /proc/$p/stat 2>/dev/null || echo 0); t=$((t + s)); done; echo $t; }
pss() { local t=0; for p in $(tree $APP); do s=$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null || echo 0); t=$((t + s)); done; echo $t; }
C0=$(cpu); sleep 10; C1=$(cpu)
echo "{\"tree_cpu_ticks_10s\": $((C1 - C0)), \"clk_tck\": $(getconf CLK_TCK), \"tree_pss_kb\": $(pss), \"processes\": $(tree $APP | wc -l)}" > "$RUN/cpu.json"
cat "$RUN/cpu.json"
wait $APP || true
echo "embed done"
