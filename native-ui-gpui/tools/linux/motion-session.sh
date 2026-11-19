#!/usr/bin/env bash
# Runs inside private-session.sh: turns the system's animations off and on (GNOME's enable-animations, which the
# app reads through the desktop portal) while the reply streams, and samples the things that move. The Slint half's
# tools/motion-session.sh, with the GPUI build's switches.
set -uo pipefail
out=${HOME%/home}
here=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$HOME/.cache/sotto-cargo-target-gpui/release/sotto-gpui}
[ "$HOME" = "$out/home" ] || { echo "run through private-session.sh" >&2; exit 1; }
gsettings set org.gnome.desktop.interface enable-animations true; echo "$(date +%T.%3N) set true -> $(gsettings get org.gnome.desktop.interface enable-animations)" >> "$out/steps.log"
SOTTO_GPUI_SIZE=1280x800 SOTTO_GPUI_LOOP=1 "$BIN" > "$out/app.log" 2>&1 &
APP=$!
for _ in $(seq 100); do hyprctl clients -j | grep -q "\"pid\": $APP" && break; sleep 0.1; done
"$here/win.sh" $APP size 1280x800
sleep 3
sample() { for i in 1 2 3 4 5 6 7 8; do "$here/win.sh" $APP shot "$out/$1-$i.png"; sleep 0.12; done; }
sample motion
gsettings set org.gnome.desktop.interface enable-animations false; echo "$(date +%T.%3N) set false -> $(gsettings get org.gnome.desktop.interface enable-animations)" >> "$out/steps.log"
sleep 1.5
sample reduced
gsettings set org.gnome.desktop.interface enable-animations true; echo "$(date +%T.%3N) set true -> $(gsettings get org.gnome.desktop.interface enable-animations)" >> "$out/steps.log"
sleep 1.5
sample restored
kill $APP
