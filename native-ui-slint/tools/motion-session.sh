#!/usr/bin/env bash
# Runs inside `dbus-run-session`: turns the system's animations off and on while the reply streams, and samples
# the breathing dot of "Writing a reply" (which reduced motion holds still).
set -uo pipefail
out=${HOME%/home}
here=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$HOME/.cache/sotto-cargo-target/release/sotto-slint}
[ "$HOME" = "$out/home" ] || { echo "run through private-session.sh" >&2; exit 1; }
gsettings set org.gnome.desktop.interface enable-animations true; echo "set true -> $(gsettings get org.gnome.desktop.interface enable-animations)" >> "$out/steps.log"
"$BIN" --stream > "$out/app.log" 2>&1 &
APP=$!
for _ in $(seq 100); do hyprctl clients -j | grep -q "\"pid\": $APP" && break; sleep 0.1; done
"$here/win.sh" $APP size 1280x800
sleep 3
sample() { for i in 1 2 3 4 5 6; do "$here/win.sh" $APP shot "$out/$1-$i.png"; sleep 0.15; done; }
sample motion
gsettings set org.gnome.desktop.interface enable-animations false; echo "set false -> $(gsettings get org.gnome.desktop.interface enable-animations)" >> "$out/steps.log"
sleep 1
sample reduced
gsettings set org.gnome.desktop.interface enable-animations true; echo "set true -> $(gsettings get org.gnome.desktop.interface enable-animations)" >> "$out/steps.log"
sleep 1
sample restored
kill $APP
