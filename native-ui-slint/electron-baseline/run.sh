#!/usr/bin/env bash
# run.sh <prepare|stream|launch|hmr|rebuild|explore> [run-name]
# One Electron Sotto run inside the nested compositor (source <nested-root>/env first). The caller takes the shared lock:
#   flock $HOME/.cache/sotto-tmp/bakeoff-measure.lock ./run.sh stream 1
# Writes into runs/<mode>-<run-name>/. Electron gets a private HOME and profile and no session bus, runs Wayland-native,
# and is stopped with its whole session (setsid) at the end.
#   hmr:     `electron-vite dev` (Vite dev server + Electron), then edit_poll.py edits the composer's colour 3 times.
#   rebuild: rewrite the composer's colour (magenta or cyan by run), `npm run build`, then a launch run; the figure is
#            the edit to the first frame.
set -euo pipefail
mode=$1; name=${2:-0}
here=$(cd "$(dirname "$0")" && pwd)
slint=$(cd "$here/.." && pwd)
WT=${WT:-$(cd "$slint/.." && pwd)/.worktrees/electron-baseline}
ELECTRON=$WT/node_modules/electron/dist/electron
cache=$HOME/.cache/sotto-tmp
PROFILE=$cache/sotto-e2e-bakeoff
TEMPLATE=$cache/bakeoff-template
PHOME=$cache/bakeoff-home
run=$here/runs/$mode-$name
export BENCH_NODE=${BENCH_NODE:-$(mise where node@24.22.1)/bin/node}
: "${WAYLAND_DISPLAY:?source the nested env first}"

rm -rf "$run"; mkdir -p "$run" "$PHOME"
echo "$BENCH_NODE" > "$here/runs/node-path"
# Forge is shared: wait for 4 GB available, then note the load.
while [ "$(awk '/MemAvailable/ {print int($2/1048576)}' /proc/meminfo)" -lt 4 ]; do echo "waiting for memory" >&2; sleep 10; done
{ echo "loadavg $(cat /proc/loadavg)"; echo "mem_available_kib $(awk '/MemAvailable/ {print $2}' /proc/meminfo)"; echo "started $(date -Is)"; } > "$run/conditions.txt"

case $mode in
  prepare) rm -rf "$PROFILE"; mkdir -p "$PROFILE/native-fixture/claude" "$PROFILE/native-fixture/codex" "$PROFILE/native-fixture/project" ;;
  stream|launch|explore|hmr|rebuild) [ -d "$TEMPLATE" ] || { echo "run prepare first" >&2; exit 1; }; rm -rf "$PROFILE"; cp -a "$TEMPLATE" "$PROFILE" ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac

wait_file() { # file timeout-seconds
  local i; for ((i = 0; i < $2 * 20; i++)); do [ -e "$1" ] && return 0; [ -e "$run/error" ] && { cat "$run/error" >&2; return 1; }; sleep 0.05; done
  echo "timed out waiting for $1" >&2; return 1
}

cd "$WT"
CSS=$WT/src/renderer/src/agents/threads.css
if [ "$mode" = rebuild ]; then
  colour=$([ $((name % 2)) = 1 ] && echo '#ff00ff' || echo '#00ffff')
  python3 - "$CSS" "$colour" "$run/edit_t0_ns" <<'PY'
import re, sys, time
path, colour, stamp = sys.argv[1:4]
text = open(path, encoding='utf-8').read()
rule = re.compile(r'(\.thread-prompt \{ display: grid;[^}]*background: )([^;]+)(; \})')
assert len(rule.findall(text)) == 1
edited = rule.sub(lambda m: m.group(1) + colour + m.group(3), text)
t0 = time.time_ns()
open(path, 'w', encoding='utf-8').write(edited)
open(stamp, 'w').write(str(t0))
PY
  echo "$colour" > "$run/colour"
  b0=$(date +%s%N)
  env NODE_OPTIONS=--max-old-space-size=3072 TMPDIR="$cache" PATH="$(dirname "$BENCH_NODE"):$PATH" npm run build > "$run/build.log" 2>&1
  echo $(( ($(date +%s%N) - b0) / 1000000 )) > "$run/build_ms"
fi
if [ "$mode" = hmr ]; then
  app=("$WT/node_modules/.bin/electron-vite" dev -- --ozone-platform=wayland)
  options="--require $here/bench-main.cjs --max-old-space-size=3072"
else
  app=("$ELECTRON" --ozone-platform=wayland out/main/index.js)
  options="--require $here/bench-main.cjs"
fi
hook_mode=$([ "$mode" = rebuild ] && echo launch || echo "$mode")
t0=$(date +%s%N)
env -i PATH="$(dirname "$BENCH_NODE"):/usr/local/bin:/usr/bin:/bin" HOME="$PHOME" LANG=en_US.UTF-8 TZ=UTC \
  XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" WAYLAND_DISPLAY="$WAYLAND_DISPLAY" XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=Hyprland \
  XDG_CONFIG_HOME="$PHOME/.config" XDG_CACHE_HOME="$PHOME/.cache" XDG_DATA_HOME="$PHOME/.local/share" \
  SOTTO_E2E=1 SOTTO_E2E_SCENARIO=success SOTTO_E2E_USER_DATA="$PROFILE" \
  SOTTO_E2E_NATIVE_FIXTURE_ROOT="$PROFILE/native-fixture" SOTTO_E2E_NATIVE_FIXTURE_EXECUTABLE="$here/fake-provider.sh" \
  BENCH_NODE="$BENCH_NODE" BENCH_MODE="$hook_mode" BENCH_DIR="$run" BENCH_HISTORY="$slint/content/history.json" BENCH_REPLY="$slint/content/reply.md" \
  BENCH_SNIPPET="Tab reaches every control in the export button in reading order" \
  NODE_OPTIONS="$options" \
  setsid "${app[@]}" > "$run/electron.log" 2>&1 < /dev/null &
pid=$!
echo "$t0" > "$run/t0_ns"
echo "$pid" > "$run/pid"

stop() {
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  kill -KILL "$pid" 2>/dev/null || true
  # Anything still in the app's session (the fake CLI, a zygote) is ours: stop it by PID.
  for left in $(pgrep -s "$pid" || true); do kill -KILL "$left" 2>/dev/null || true; done
}
trap stop EXIT

client() { "$here/win-main.sh" "$pid" client; }

case $mode in
  prepare)
    wait_file "$run/prepared.json" 180
    for _ in $(seq 200); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    stop; trap - EXIT
    rm -rf "$TEMPLATE"; cp -a "$PROFILE" "$TEMPLATE"
    echo "prepared"
    ;;
  stream)
    wait_file "$run/window-ready" 120
    "$here/win-main.sh" "$pid" size 1280x800
    sleep 0.5
    client > "$run/client.json"
    python3 -c "import json,sys; c=json.load(open(sys.argv[1])); sys.exit(0 if c['size']==[1280,800] and not c['xwayland'] else 'window is %r, xwayland %r' % (c['size'], c['xwayland']))" "$run/client.json"
    "$here/win-main.sh" "$pid" shot "$run/before.png"
    touch "$run/sized"
    wait_file "$run/stream-started" 60
    # SHOTS=1 (trial runs only, never measured ones): capture the window mid-stream.
    [ -n "${SHOTS:-}" ] && ( for t in 4 9 14; do sleep 5; "$here/win-main.sh" "$pid" shot "$run/during-$t.png"; done ) &
    sleep 1
    # 60 key presses, 150 ms apart, into the focused composer while the reply streams.
    keys=$(python3 -c "print(''.join(chr(97 + i % 26) for i in range(60)))")
    date +%s%N > "$run/typing-start_ns"
    wtype -d 150 "$keys"
    date +%s%N > "$run/typing-end_ns"
    wait_file "$run/stream-ended" 90
    end_ms=$(cat "$run/stream-ended")
    python3 -c "import time; time.sleep(max(0, ($end_ms + 5000) / 1000 - time.time()))"
    date +%s%N > "$run/memory_ns"
    python3 "$here/memory.py" "$pid" "$run/memory.json"
    "$here/win-main.sh" "$pid" shot "$run/after.png"
    touch "$run/memory-done"
    wait_file "$run/done" 60
    ;;
  hmr)
    wait_file "$run/window-ready" 300
    epid=$(cat "$run/window-ready")
    "$here/win-main.sh" "$epid" size 1280x800
    "$here/win-main.sh" "$epid" client > "$run/client.json"
    sleep 3
    "$here/win-main.sh" "$epid" shot "$run/before.png"
    # The composer's top padding, left of the text: x 420-460, y 676-684 in the 1280x800 window at the output's origin.
    python3 "$here/edit_poll.py" "$CSS" "420,676 40x8" 3 "$run/edit.json"
    ;;
  launch|rebuild)
    wait_file "$run/launch.json" 120
    client > "$run/client.json"
    ;;
  explore)
    wait_file "$run/window-ready" 120 || true
    echo "$pid"; trap - EXIT
    ;;
esac
echo "$run"
