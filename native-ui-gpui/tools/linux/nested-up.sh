#!/usr/bin/env bash
# The same harness as the Slint half's tools/nested-up.sh, so the figures line up.
# Starts two nested Hyprland compositors owned by this run (A inside the live session, B inside A,
# B floated at 1800x1200 so window sizes are ours to pick) and writes their details to $ROOT/env.
# The live session is never changed. Stop everything with nested-down.sh $ROOT.
set -euo pipefail
export XDG_RUNTIME_DIR=/run/user/1000
LIVE_PID=$(pgrep -x quickshell | head -1)
LIVE_WL=$(tr '\0' '\n' < /proc/$LIVE_PID/environ | grep '^WAYLAND_DISPLAY=' | cut -d= -f2)
ROOT=$(mktemp -d /tmp/gbo-XXXXXX)
MODE=${MODE:-1800x1200@60}
for n in a b; do
  printf 'hl.monitor({ output = "", mode = "%s", position = "0x0", scale = 1 })\nhl.config({ animations = { enabled = false } })\n' "$MODE" > "$ROOT/$n.lua"
done
start() { # name parent-socket
  env -u HYPRLAND_INSTANCE_SIGNATURE XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY="$2" HYPRLAND_NO_SD_NOTIFY=1 \
    setsid -f Hyprland -c "$ROOT/$1.lua" > "$ROOT/$1.log" 2>&1 < /dev/null
  for _ in $(seq 100); do
    pid=$(pgrep -f "Hyprland -c $ROOT/$1.lua" | head -1 || true)
    if [ -n "$pid" ]; then
      inst=$(hyprctl instances -j | python3 -c "import json,sys; d=[i for i in json.load(sys.stdin) if i['pid']==$pid]; print(d[0]['instance']+' '+d[0]['wl_socket'] if d else '')")
      [ -n "$inst" ] && { echo "$pid $inst"; return; }
    fi
    sleep 0.2
  done
  echo "compositor $1 did not start" >&2; exit 1
}
read -r APID ASIG AWL < <(start a "$LIVE_WL")
read -r BPID BSIG BWL < <(start b "$AWL")
for _ in $(seq 50); do
  ADDR=$(HYPRLAND_INSTANCE_SIGNATURE=$ASIG hyprctl clients -j | python3 -c "import json,sys; d=[c for c in json.load(sys.stdin) if c['pid']==$BPID]; print(d[0]['address'] if d else '')")
  [ -n "$ADDR" ] && break; sleep 0.2
done
W=${MODE%x*}; H=${MODE#*x}; H=${H%@*}
HYPRLAND_INSTANCE_SIGNATURE=$ASIG hyprctl dispatch "hl.dsp.window.float({ action = \"enable\", window = \"address:$ADDR\" })" >/dev/null
HYPRLAND_INSTANCE_SIGNATURE=$ASIG hyprctl dispatch "hl.dsp.window.resize({ x = $W, y = $H, window = \"address:$ADDR\" })" >/dev/null
sleep 0.5
HYPRLAND_INSTANCE_SIGNATURE=$BSIG hyprctl dismissnotify >/dev/null 2>&1 || true
cat > "$ROOT/env" <<EOT
export XDG_RUNTIME_DIR=/run/user/1000
export WAYLAND_DISPLAY=$BWL
export HYPRLAND_INSTANCE_SIGNATURE=$BSIG
export NESTED_A_SIGNATURE=$ASIG
export NESTED_ROOT=$ROOT
export NESTED_PIDS="$APID $BPID"
EOT
echo "$ROOT"
