#!/usr/bin/env bash
# private-session.sh <outdir> <script> [args]: runs <script> on a private D-Bus session whose daemon, and so every
# service it starts (dconf, the portal, the accessibility bus), has a private HOME and XDG folders under <outdir>.
# The user's real settings are never reachable from inside. (A HOME exported only inside dbus-run-session is not
# enough: dconf-service is started by the bus daemon and inherits the daemon's HOME.)
set -euo pipefail
out=$1; shift
export BIN=${BIN:-$HOME/.cache/sotto-cargo-target/release/sotto-slint}
export HOME=$out/home XDG_CONFIG_HOME=$out/home/.config XDG_DATA_HOME=$out/home/.local/share XDG_CACHE_HOME=$out/home/.cache XDG_STATE_HOME=$out/home/.local/state
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
exec dbus-run-session -- "$@"
