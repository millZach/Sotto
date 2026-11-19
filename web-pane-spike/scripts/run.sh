#!/usr/bin/env bash
# Runs one spike mode with its own HOME, XDG folders and run folder, so nothing touches the user's profile or keyring.
# Usage: run.sh <mode> <run-name> [VAR=value ...]
set -euo pipefail
MODE="$1"; NAME="$2"; shift 2
DIST="${DIST:-$HOME/.cache/sotto-tmp/wp-dist}"
RUNS="${RUNS:-$HOME/.cache/sotto-tmp/runs}"
RUN="$RUNS/$NAME"
rm -rf "$RUN"; mkdir -p "$RUN/home/.config" "$RUN/home/.cache" "$RUN/home/.local/share" "$RUN/xdg-runtime"
chmod 700 "$RUN/xdg-runtime"
cd "$DIST"
env -u DBUS_SESSION_BUS_ADDRESS HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/home/.config" XDG_CACHE_HOME="$RUN/home/.cache" \
  XDG_DATA_HOME="$RUN/home/.local/share" WP_MODE="$MODE" WP_RUN_DIR="$RUN" LD_LIBRARY_PATH="$DIST" "$@" \
  ${WRAP:-} ./webpane > "$RUN/stdout.log" 2> "$RUN/stderr.log" && code=0 || code=$?
echo "exit $code -> $RUN"
