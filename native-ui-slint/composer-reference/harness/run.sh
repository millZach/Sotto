#!/usr/bin/env bash
# run.sh <prepare|drive>   (source <nested-root>/env first; the caller holds the bake-off lock with flock -o)
# Adapted from ../../electron-baseline/run.sh. Electron gets a private HOME and profile and no session bus, runs
# Wayland-native, and runs in its own session (setsid). prepare seeds one finished Claude thread and saves the profile as
# a template. drive restores the template, starts Sotto, sizes its window to 1280x800 at the output's origin, prints
# Electron's PID and leaves it running for ev.sh; stop.sh <pid> stops it.
set -euo pipefail
mode=$1
here=$(cd "$(dirname "$0")" && pwd)
slint=$(cd "$here/../.." && pwd)
WT=${WT:-$(cd "$slint/.." && pwd)/.worktrees/electron-baseline}
ELECTRON=$WT/node_modules/electron/dist/electron
cache=$HOME/.cache/sotto-tmp
PROFILE=$cache/cref-profile
TEMPLATE=$cache/cref-template
PHOME=$cache/cref-home
run=$cache/cref-run
NODE24=$(mise where node@24.22.1)/bin/node
: "${WAYLAND_DISPLAY:?source the nested env first}"
echo "$NODE24" > "$here/node-path"
rm -rf "$run"; mkdir -p "$run" "$PHOME"
case $mode in
  prepare)
    rm -rf "$PROFILE"; mkdir -p "$PROFILE/native-fixture/claude" "$PROFILE/native-fixture/codex" "$PROFILE/native-fixture/project"
    # The catalog Sotto's own worker-roles journey uses, with fast mode offered on Opus so the effort word shows its bolt.
    cat > "$PROFILE/native-fixture/claude/models.json" <<'JSON'
[{"value":"opus","displayName":"Opus 5.5","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsFastMode":true},
 {"value":"sonnet","displayName":"Sonnet 5.5","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
 {"value":"haiku","displayName":"Haiku 5.5","supportsEffort":false}]
JSON
    ;;
  drive) [ -d "$TEMPLATE" ] || { echo "run prepare first" >&2; exit 1; }; rm -rf "$PROFILE"; cp -a "$TEMPLATE" "$PROFILE" ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
wait_file() { local i; for ((i = 0; i < $2 * 20; i++)); do [ -e "$1" ] && return 0; [ -e "$run/error" ] && { cat "$run/error" >&2; return 1; }; sleep 0.05; done; echo "timed out waiting for $1" >&2; return 1; }
cd "$WT"
env -i PATH="$(dirname "$NODE24"):/usr/local/bin:/usr/bin:/bin" HOME="$PHOME" LANG=en_US.UTF-8 TZ=UTC \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" WAYLAND_DISPLAY="$WAYLAND_DISPLAY" XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=Hyprland \
  XDG_CONFIG_HOME="$PHOME/.config" XDG_CACHE_HOME="$PHOME/.cache" XDG_DATA_HOME="$PHOME/.local/share" \
  SOTTO_E2E=1 SOTTO_E2E_SCENARIO=success SOTTO_E2E_USER_DATA="$PROFILE" \
  SOTTO_E2E_NATIVE_FIXTURE_ROOT="$PROFILE/native-fixture" SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE="$here/provider.sh" \
  CREF_MODE="$mode" CREF_DIR="$run" NODE_OPTIONS="--require $here/cref-main.cjs" \
  setsid "$ELECTRON" --ozone-platform=wayland out/main/index.js > "$run/electron.log" 2>&1 < /dev/null &
pid=$!
echo "$pid" > "$run/pid"
case $mode in
  prepare)
    wait_file "$run/prepared.json" 180 || { "$here/stop.sh" "$pid"; exit 1; }
    for _ in $(seq 200); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    "$here/stop.sh" "$pid"
    rm -rf "$TEMPLATE"; cp -a "$PROFILE" "$TEMPLATE"
    cat "$run/prepared.json"; echo prepared
    ;;
  drive)
    wait_file "$run/window-ready" 120 || { "$here/stop.sh" "$pid"; exit 1; }
    "$slint/electron-baseline/win-main.sh" "$pid" size 1280x800
    "$slint/electron-baseline/win-main.sh" "$pid" client > "$run/client.json"
    echo "$pid"
    ;;
esac
