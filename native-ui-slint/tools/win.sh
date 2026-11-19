#!/usr/bin/env bash
# win.sh <pid> size WxH | shot <file> | key <wtype args...>  (run with a nested env sourced)
set -euo pipefail
pid=$1; cmd=$2; shift 2
addr() { hyprctl clients -j | python3 -c "import json,sys; d=[c for c in json.load(sys.stdin) if c['pid']==$pid]; print(d[0]['address'] if d else '')"; }
geom() { hyprctl clients -j | python3 -c "import json,sys; d=[c for c in json.load(sys.stdin) if c['pid']==$pid][0]; print('%d,%d %dx%d'%(d['at'][0],d['at'][1],d['size'][0],d['size'][1]))"; }
case $cmd in
  size)
    a=$(addr); w=${1%x*}; h=${1#*x}
    hyprctl dispatch "hl.dsp.window.float({ action = \"enable\", window = \"address:$a\" })" >/dev/null
    hyprctl dispatch "hl.dsp.window.resize({ x = $w, y = $h, window = \"address:$a\" })" >/dev/null
    hyprctl dispatch "hl.dsp.window.move({ x = 0, y = 0, window = \"address:$a\" })" >/dev/null
    hyprctl dispatch "hl.dsp.focus({ window = \"address:$a\" })" >/dev/null 2>&1 || true
    ;;
  shot) sleep 0.3; grim -g "$(geom)" "$1" ;;
  geom) geom ;;
esac
