#!/usr/bin/env bash
# Runs inside `dbus-run-session`: an accessibility bus, Orca with its debug log, the app, and a script of keys.
# a11y-session.sh <outdir> <app args...>
set -uo pipefail
out=${HOME%/home}
here=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$HOME/.cache/sotto-cargo-target/release/sotto-slint}
[ "$HOME" = "$out/home" ] || { echo "run through private-session.sh" >&2; exit 1; }
/usr/lib/at-spi-bus-launcher --launch-immediately > "$out/atspi.log" 2>&1 &
ATSPI=$!
sleep 1
gsettings set org.gnome.desktop.a11y.applications screen-reader-enabled true 2>/dev/null
orca --replace --debug-file="$out/orca-debug.out" > "$out/orca.log" 2>&1 &
ORCA=$!
sleep 3
"$BIN" "$@" > "$out/app.log" 2>&1 &
APP=$!
for _ in $(seq 100); do hyprctl clients -j | grep -q "\"pid\": $APP" && break; sleep 0.1; done
"$here/win.sh" $APP size 1280x800
sleep 3
python3 "$here/atspi-dump.py" sotto 600 > "$out/tree.txt" 2>&1
# Keys: a script file of wtype argument lines (KEYS=path), or the default walk.
keys() { echo "KEYS $*" >> "$out/keys.log"; wtype "$@"; sleep 1.1; }
if [ -n "${KEYS:-}" ]; then
  while IFS= read -r line; do [ -z "$line" ] && continue; case $line in \#*) continue;; @shot\ *) "$here/win.sh" $APP shot "$out/${line#@shot }.png"; continue;; esac; eval "keys $line"; done < "$KEYS"
else
  for i in $(seq 1 14); do keys -k Tab; done
fi
wl-paste -n > "$out/clipboard.txt" 2>&1 || true
grim "$out/after-keys.png" 2>/dev/null
sleep 2
kill $APP $ORCA $ATSPI 2>/dev/null
wait 2>/dev/null
