#!/usr/bin/env bash
# Runs inside private-session.sh: an accessibility bus, Orca with its debug log, the app, and a script of keys.
# a11y-session.sh  (KEYS=<file of wtype argument lines; "@shot name" captures; "@tree name" dumps the AT-SPI tree>)
# The Slint half's tools/a11y-session.sh, with the GPUI build's switches.
set -uo pipefail
out=${HOME%/home}
here=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$HOME/.cache/sotto-cargo-target-gpui/release/sotto-gpui}
[ "$HOME" = "$out/home" ] || { echo "run through private-session.sh" >&2; exit 1; }
/usr/lib/at-spi-bus-launcher --launch-immediately > "$out/atspi.log" 2>&1 &
ATSPI=$!
sleep 1
gsettings set org.gnome.desktop.a11y.applications screen-reader-enabled true 2>/dev/null
orca --replace --debug-file="$out/orca-debug.out" > "$out/orca.log" 2>&1 &
ORCA=$!
sleep 3
SOTTO_GPUI_SIZE=1280x800 "$BIN" > "$out/app.log" 2>&1 &
APP=$!
for _ in $(seq 100); do hyprctl clients -j | grep -q "\"pid\": $APP" && break; sleep 0.1; done
"$here/win.sh" $APP size 1280x800
sleep 3
python3 "$here/atspi-dump.py" "${APPNAME:-sotto}" 800 > "$out/tree.txt" 2>&1
orca() { busctl --user call org.gnome.Orca1.Service /org/gnome/Orca1/Service/$1 org.gnome.Orca1.$1 $2 b true >> "$out/orca-calls.log" 2>&1; }
keys() { echo "$(date +%H:%M:%S.%6N) KEYS $*" >> "$out/keys.log"; wtype "$@"; sleep 1.1; }
while IFS= read -r line; do
  [ -z "$line" ] && continue
  case $line in
    \#*) continue;;
    @shot\ *) "$here/win.sh" $APP shot "$out/${line#@shot }.png"; continue;;
    @tree\ *) python3 "$here/atspi-dump.py" "${APPNAME:-sotto}" 800 > "$out/tree-${line#@tree }.txt" 2>&1; continue;;
    @sleep\ *) sleep "${line#@sleep }"; continue;;
    @cmd\ *) echo "$(date +%H:%M:%S.%6N) KEYS (cmd) ${line#@cmd }" >> "$out/keys.log"; eval "${line#@cmd }"; sleep 1.1; continue;;
  esac
  eval "keys $line"
done < "$KEYS"
wl-paste -n > "$out/clipboard.txt" 2>&1 || true
sleep 1
kill $APP $ORCA $ATSPI 2>/dev/null
wait 2>/dev/null
