#!/usr/bin/env bash
# private-session.sh <outdir> <script> [args]: runs <script> on a private D-Bus session whose daemon, and so every
# service it starts (dconf, the portal, the accessibility bus), has a private HOME and XDG folders under <outdir>.
# The Slint half found that a HOME exported only inside dbus-run-session is not enough: dconf-service is started by
# the bus daemon and inherits the daemon's HOME, and wrote to the real user's database. Same approach here.
set -euo pipefail
out=$1; shift
export BIN=${BIN:-$HOME/.cache/sotto-cargo-target-gpui/release/sotto-gpui}
export HOME=$out/home XDG_CONFIG_HOME=$out/home/.config XDG_DATA_HOME=$out/home/.local/share XDG_CACHE_HOME=$out/home/.cache XDG_STATE_HOME=$out/home/.local/state
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
exec dbus-run-session -- "$@"
