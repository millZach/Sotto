#!/usr/bin/env bash
# win-main.sh <pid> size WxH | shot <file> | client  -- tools/win.sh for Sotto's main window: Electron's process owns two
# Wayland windows (the main window and the floating widget), so this picks the largest one not titled "Sotto Widget".
set -euo pipefail
pid=$1; cmd=$2; shift 2
pick() { hyprctl clients -j | python3 -c "import json,sys; d=sorted([c for c in json.load(sys.stdin) if c['pid']==$pid and c['title']!='Sotto Widget'], key=lambda c: -c['size'][0]*c['size'][1]); print($1 if d else '')"; }
case $cmd in
  size)
    w=${1%x*}; h=${1#*x}
    for _ in $(seq 50); do
    a=$(pick "d[0]['address']")
    [ "$(pick "'%dx%d'%tuple(d[0]['size'])")" = "${w}x${h}" ] && [ "$(pick "'%d,%d'%tuple(d[0]['at'])")" = "0,0" ] && break
    hyprctl dispatch "hl.dsp.window.float({ action = \"enable\", window = \"address:$a\" })" >/dev/null
    hyprctl dispatch "hl.dsp.window.resize({ x = $w, y = $h, window = \"address:$a\" })" >/dev/null
    hyprctl dispatch "hl.dsp.window.move({ x = 0, y = 0, window = \"address:$a\" })" >/dev/null
    hyprctl dispatch "hl.dsp.focus({ window = \"address:$a\" })" >/dev/null 2>&1 || true
    sleep 0.1
    done
    hyprctl dispatch "hl.dsp.focus({ window = \"address:$a\" })" >/dev/null 2>&1 || true
    ;;
  shot) sleep 0.3; grim -g "$(pick "'%d,%d %dx%d'%(d[0]['at'][0],d[0]['at'][1],d[0]['size'][0],d[0]['size'][1])")" "$1" ;;
  client) pick "json.dumps(d[0])" ;;
esac
