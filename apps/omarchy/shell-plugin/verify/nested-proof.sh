#!/bin/bash

# Proves Sotto's Omarchy shell plugin, sotto.dictation, in an owned nested
# copy of the Omarchy shell, and leaves the live session alone: no key,
# click, shell IPC call or config write reaches it.
#
# Two nested Hyprland instances. A runs as a window of the live session,
# which tiles it to whatever size it likes; B runs inside A, which floats
# B's two displays at exact sizes (1600x1000 and 1280x800). The Omarchy
# shell runs in B with its own HOME, XDG folders, runtime folder and D-Bus
# session, the plugin is installed by install-shell-plugin.sh, and stand-in
# `sotto` launchers record the verbs they receive. A virtual pointer inside B
# drags and clicks. Every process runs in one systemd slice that is stopped
# at the end, and only the Hyprland runtime folders this run made are
# removed.
#
# Usage, from a Sotto checkout on an Omarchy machine, in its desktop session:
#   apps/omarchy/shell-plugin/verify/nested-proof.sh <out-dir>
# Needs Hyprland, quickshell, grim, ImageMagick, jq, foot, systemd --user,
# dbus-run-session and cc with the Wayland client headers. It writes raw
# captures to <out-dir>/raw, composites to <out-dir>/curated and the
# checks to <out-dir>/proof.txt.

set -euo pipefail

out=$(realpath -m -- "${1:?usage: nested-proof.sh <out-dir>}")
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
omarchy_dir=$(cd -- "$here/../.." && pwd -P)
omarchy_path=${OMARCHY_PATH:-/usr/share/omarchy}
uid=$(id -u)
run=/run/user/$uid
mkdir -p "$out/raw" "$out/curated"
: >"$out/proof.txt"

say() { printf '%s\n' "$*" | tee -a "$out/proof.txt"; }
fail() { say "FAIL: $*"; exit 1; }
passes=0
check() { # condition-as-exit-status message
  if eval "$1"; then passes=$((passes + 1)); say "PASS: $2"; else fail "$2 ($1)"; fi
}

for tool in Hyprland hyprctl quickshell qs grim magick jq foot cc systemd-run dbus-run-session omarchy; do
  command -v "$tool" >/dev/null || fail "$tool is missing"
done

# systemd-run and systemctl talk to the live user manager; nothing else does.
export XDG_RUNTIME_DIR=$run DBUS_SESSION_BUS_ADDRESS=unix:path=$run/bus

# ------------------------------------------------------------ the live session

# The live shell is the quickshell running Omarchy's config in the real
# runtime folder and outside any proof slice; its environment names the live
# compositor. Never inferred from the newest instance folder.
live_sig="" live_wl=""
for pid in $(pgrep -x quickshell || true); do
  grep -q proof "/proc/$pid/cgroup" 2>/dev/null && continue
  env_of() { tr '\0' '\n' <"/proc/$pid/environ" | sed -n "s/^$1=//p"; }
  [[ $(env_of XDG_RUNTIME_DIR) == "$run" ]] || continue
  [[ -n $live_sig ]] && fail "more than one live Omarchy shell; cannot tell which is live"
  live_sig=$(env_of HYPRLAND_INSTANCE_SIGNATURE)
  live_wl=$(env_of WAYLAND_DISPLAY)
done
[[ -n $live_sig && -n $live_wl ]] || fail "the live Omarchy shell was not found"
snapshot_instances() { (cd "$run/hypr" && for d in */; do stat -c '%n %i' "${d%/}"; done) | sort; }
instances_before=$(snapshot_instances)
grep -q "^$live_sig " <<<"$instances_before" || fail "the live instance folder is missing"
say "live: $live_sig on $live_wl (untouched)"
live_config_stamp=$(stat -c '%Y %s' "$HOME/.config/omarchy/shell.json" 2>/dev/null || echo none)
live_plugins=$(ls -A "$HOME/.config/omarchy/plugins" 2>/dev/null || true)

# ------------------------------------------------------------- ownership

token=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
slice=app-sottoshellproof$token.slice
work=$(mktemp -d /tmp/sotto-shell-proof.XXXXXX)
# A short runtime folder: Hyprland's socket path must fit in 108 bytes.
rt=$(mktemp -d /tmp/ssp-XXXXXX)
home=$work/home
units=0
a_pid="" b_pid="" a_sig="" b_sig="" a_wl="" b_wl="" a_ino="" b_ino=""

# A background command reads /dev/null unless it names its own stdin, so
# the pointer passes its pipe in `scoped_stdin`.
scoped() { # name env-file command... (its output goes to <work>/<name>.log)
  local name=$1 envfile=$2
  shift 2
  units=$((units + 1))
  # shellcheck disable=SC2046
  systemd-run --user --scope --quiet --collect --unit="sotto-shell-proof-$token-$units-$name.scope" \
    --slice="$slice" --property=KillMode=control-group --property=TimeoutStopSec=2s \
    -- /usr/bin/env -i $(cat "$envfile") "$@" <"${scoped_stdin:-/dev/null}" >>"$work/$name.log" 2>&1 &
  last_pid=$!
}

remove_instance_folder() { # sig inode pid
  local sig=$1 ino=$2 pid=$3 dir=$run/hypr/$1
  [[ -n $sig && $sig != "$live_sig" && -d $dir ]] || return 0
  [[ $(stat -c %i "$dir") == "$ino" ]] || { say "left $sig alone: it was replaced"; return 0; }
  if [[ -f $dir/hyprland.lock ]]; then
    [[ $(head -n1 "$dir/hyprland.lock") == "$pid" ]] || { say "left $sig alone: another process holds it"; return 0; }
  fi
  rm -rf -- "$dir"
}

cleanup() {
  local status=$?
  set +e
  exec 7>&- 2>/dev/null
  systemctl --user stop "$slice" 2>/dev/null
  for _ in $(seq 1 40); do
    grep -lq "$slice" /proc/[0-9]*/cgroup 2>/dev/null || break
    sleep 0.1
  done
  local left
  left=$(grep -l "$slice" /proc/[0-9]*/cgroup 2>/dev/null | cut -d/ -f3 | tr '\n' ' ')
  say "processes left in the proof slice: [${left}]"
  remove_instance_folder "$b_sig" "$b_ino" "$b_pid"
  remove_instance_folder "$a_sig" "$a_ino" "$a_pid"
  local after
  after=$(snapshot_instances)
  while read -r name ino; do
    # Another session's nested Hyprland may come and go meanwhile; the live
    # one must not.
    if ! grep -q "^$name $ino\$" <<<"$after"; then
      [[ $name == "$live_sig" ]] && say "WARNING: the live instance folder changed" || say "note: $name, not this proof's, changed meanwhile"
    fi
  done <<<"$instances_before"
  [[ -n $b_sig ]] && grep -q "^$b_sig " <<<"$after" && say "WARNING: $b_sig is still there"
  [[ -n $a_sig ]] && grep -q "^$a_sig " <<<"$after" && say "WARNING: $a_sig is still there"
  say "instance folders after cleanup: $(cut -d' ' -f1 <<<"$after" | tr '\n' ' ')"
  [[ $(stat -c '%Y %s' "$HOME/.config/omarchy/shell.json" 2>/dev/null || echo none) == "$live_config_stamp" ]] \
    && say "live shell.json unchanged" || say "WARNING: live shell.json changed"
  [[ $(ls -A "$HOME/.config/omarchy/plugins" 2>/dev/null || true) == "$live_plugins" ]] \
    && say "live plugins folder unchanged" || say "WARNING: live plugins folder changed"
  mkdir -p "$out/logs"
  cp "$work"/*.log "$out/logs/" 2>/dev/null
  [[ $work == /tmp/sotto-shell-proof.* ]] && rm -rf -- "$work"
  [[ $rt == /tmp/ssp-* ]] && rm -rf -- "$rt"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for() { # seconds condition
  local deadline=$((SECONDS + $1))
  until eval "$2"; do
    ((SECONDS < deadline)) || return 1
    sleep 0.1
  done
}

instance_of() { # pid -> "sig socket"
  hyprctl instances -j 2>/dev/null | jq -r --argjson pid "$1" '.[] | select(.pid == $pid) | "\(.instance) \(.wl_socket)"'
}

# ------------------------------------------------------------- nested A and B

cat >"$work/hypr-a.lua" <<'EOF'
package.path = (os.getenv("OMARCHY_PATH") or "/usr/share/omarchy") .. "/?.lua;" .. package.path
require("default.hypr.helpers")
hl.monitor({ output = "", mode = "1280x800@60", position = "0x0", scale = 1 })
EOF
cat >"$work/hypr-b.lua" <<'EOF'
package.path = (os.getenv("OMARCHY_PATH") or "/usr/share/omarchy") .. "/?.lua;" .. package.path
require("default.hypr.helpers")
require("default.hypr.looknfeel")
require("default.hypr.input")
require("default.hypr.apps.omarchy-shell")
hl.monitor({ output = "WAYLAND-1", mode = "1600x1000@60", position = "0x0", scale = 1 })
hl.monitor({ output = "WAYLAND-2", mode = "1280x800@60", position = "1600x0", scale = 1 })
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = 1 })
EOF
mkdir -p "$home"
hypr_env() { # parent-display
  printf '%s\n' "HOME=$home" "XDG_CONFIG_HOME=$home/.config" "XDG_RUNTIME_DIR=$run" "WAYLAND_DISPLAY=$1" \
    "OMARCHY_PATH=$omarchy_path" "PATH=/usr/bin:/bin" "HYPRLAND_NO_SD_NOTIFY=1" \
    "DBUS_SESSION_BUS_ADDRESS=unix:path=$work/no-bus"
}

hypr_env "$live_wl" >"$work/env-a"
scoped hyprland-a "$work/env-a" Hyprland -c "$work/hypr-a.lua"
a_pid=$last_pid
wait_for 20 '[[ -n $(instance_of "$a_pid") ]]' || fail "nested Hyprland A did not start"
read -r a_sig a_wl <<<"$(instance_of "$a_pid")"
a_ino=$(stat -c %i "$run/hypr/$a_sig")
[[ $a_sig != "$live_sig" && $a_wl != "$live_wl" ]] || fail "A is the live instance"

hypr_a() {
  [[ $a_sig != "$live_sig" ]] || fail "refusing to address the live instance"
  HYPRLAND_INSTANCE_SIGNATURE=$a_sig hyprctl "$@"
}
hypr_b() {
  [[ -n $b_sig && $b_sig != "$live_sig" && $b_sig != "$a_sig" ]] || fail "refusing to address an instance this proof does not own"
  HYPRLAND_INSTANCE_SIGNATURE=$b_sig hyprctl "$@"
}

hypr_env "$a_wl" >"$work/env-b"
scoped hyprland-b "$work/env-b" Hyprland -c "$work/hypr-b.lua"
b_pid=$last_pid
wait_for 20 '[[ -n $(instance_of "$b_pid") ]]' || fail "nested Hyprland B did not start"
read -r b_sig b_wl <<<"$(instance_of "$b_pid")"
b_ino=$(stat -c %i "$run/hypr/$b_sig")
say "nested A: $a_sig on $a_wl, PID $a_pid; nested B: $b_sig on $b_wl, PID $b_pid"
hypr_b output create wayland >/dev/null

b_window() { hypr_a clients -j | jq -r --argjson pid "$b_pid" --arg t "aquamarine - $1" '.[] | select(.pid == $pid and .title == $t) | .address'; }
wait_for 10 '[[ -n $(b_window WAYLAND-1) && -n $(b_window WAYLAND-2) ]]' || fail "B's displays did not open in A"
for spec in WAYLAND-1:1600:1000:0:0 WAYLAND-2:1280:800:300:120; do
  IFS=: read -r name w h x y <<<"$spec"
  address=$(b_window "$name")
  hypr_a dispatch "hl.dsp.window.float({ action = \"enable\", window = \"address:$address\" })" >/dev/null
  hypr_a dispatch "hl.dsp.window.resize({ x = $w, y = $h, window = \"address:$address\" })" >/dev/null
  hypr_a dispatch "hl.dsp.window.move({ x = $x, y = $y, window = \"address:$address\" })" >/dev/null
done
displays() { hypr_b monitors -j | jq -r 'sort_by(.x) | map("\(.name)=\(.width)x\(.height)@\(.x)") | join(" ")'; }
wait_for 10 '[[ $(displays) == "WAYLAND-1=1600x1000@0 WAYLAND-2=1280x800@1600" ]]' || fail "B's displays did not take their sizes: $(displays)"
check '[[ $(displays) == "WAYLAND-1=1600x1000@0 WAYLAND-2=1280x800@1600" ]]' "B has two displays, 1600x1000 and 1280x800"
# Hyprland's own banner about start-hyprland would sit in every capture.
hypr_a dismissnotify >/dev/null
hypr_b dismissnotify >/dev/null

# ---------------------------------------------------------- isolated Omarchy

mkdir -p "$home/.config" "$home/.local/state/omarchy/current" "$home/.cache" "$home/.local/share"
cp -r "$HOME/.config/omarchy" "$home/.config/omarchy"
rm -rf -- "$home/.config/omarchy/plugins"
mkdir -p "$home/.config/omarchy/plugins"
[[ -d $HOME/.config/foot ]] && cp -r "$HOME/.config/foot" "$home/.config/foot"
# Services that would reach past the nested session stay off in the copy.
config=$home/.config/omarchy/shell.json
[[ -s $config ]] || cp "$omarchy_path/config/omarchy/shell.json" "$config"
jq '.disabledPlugins = ((.disabledPlugins // []) + ["omarchy.polkit", "omarchy.lock", "omarchy.idle", "omarchy.nightlight"] | unique)' \
  "$config" >"$config.tmp" && mv "$config.tmp" "$config"

make_theme() {
  local next=$home/.local/state/omarchy/current/next-theme current=$home/.local/state/omarchy/current/theme
  rm -rf -- "$next"
  mkdir -p "$next"
  cp -r "$omarchy_path/themes/$1/." "$next/"
  HOME=$home OMARCHY_PATH=$omarchy_path PATH="$omarchy_path/bin:$PATH" omarchy-theme-set-templates
  rm -rf -- "$current"
  mv "$next" "$current"
  echo "$1" >"$home/.local/state/omarchy/current/theme.name"
  ln -sfn "$(find "$current/backgrounds" -maxdepth 1 -type f | sort | head -n1)" "$home/.local/state/omarchy/current/background"
}
make_theme tokyo-night

mkdir -p "$rt/hypr" "$rt/sotto"
chmod 700 "$rt" "$rt/sotto"
ln -s "$run/hypr/$b_sig" "$rt/hypr/$b_sig"
ln -s "$run/$b_wl" "$rt/$b_wl"
(($(printf '%s' "$rt/hypr/$b_sig/.socket.sock" | wc -c) < 108)) || fail "the runtime folder path is too long for Hyprland's socket"

# Stand-ins for the sotto launcher. They record what the plugin runs; the
# failing one answers as Sotto does when it is not running.
mkdir -p "$work/bin" "$work/checkout/apps/omarchy" "$work/failing"
: >"$work/verbs.log"
for stub in "$work/bin/sotto" "$work/checkout/apps/omarchy/sotto"; do
  printf '#!/bin/bash\nprintf "%%s\\t%%s\\n" "$0" "$*" >>%q\n' "$work/verbs.log" >"$stub"
done
printf '#!/bin/bash\nprintf "%%s\\t%%s\\n" "$0" "$*" >>%q\necho "Sotto could not receive the dictation command." >&2\nexit 1\n' "$work/verbs.log" >"$work/failing/sotto"
chmod +x "$work/bin/sotto" "$work/checkout/apps/omarchy/sotto" "$work/failing/sotto"
checkout_sotto=$work/checkout/apps/omarchy/sotto

printf '%s\n' "HOME=$home" "USER=$USER" "LANG=en_US.UTF-8" "PATH=$work/bin:$omarchy_path/bin:/usr/local/bin:/usr/bin:/bin" \
  "XDG_CONFIG_HOME=$home/.config" "XDG_STATE_HOME=$home/.local/state" "XDG_CACHE_HOME=$home/.cache" \
  "XDG_DATA_HOME=$home/.local/share" "XDG_RUNTIME_DIR=$rt" "WAYLAND_DISPLAY=$b_wl" \
  "HYPRLAND_INSTANCE_SIGNATURE=$b_sig" "OMARCHY_PATH=$omarchy_path" "XDG_CURRENT_DESKTOP=Hyprland" \
  "XDG_SESSION_TYPE=wayland" "QT_QPA_PLATFORM=wayland" "XCURSOR_SIZE=24" >"$work/env-shell"
in_shell() { env -i $(cat "$work/env-shell") "$@"; }

shell_up() { in_shell omarchy-shell shell ping >/dev/null 2>&1; }
start_shell() {
  scoped omarchy-shell "$work/env-shell" dbus-run-session -- quickshell -p "$omarchy_path/shell"
  wait_for 30 shell_up || fail "the nested Omarchy shell did not answer"
  sleep 2
}
start_shell
check '[[ -S $rt/quickshell/by-id/$(ls "$rt/quickshell/by-id" | head -n1)/ipc.sock ]]' "the nested shell's IPC lives in the isolated runtime folder"

# ------------------------------------------------------------- the pointer

cc "$here/nested-pointer.c" -o "$work/nested-pointer" -lwayland-client -Wall -Wextra -Werror
mkfifo "$work/pointer.in"
exec 7<>"$work/pointer.in"
printf '%s\n' "XDG_RUNTIME_DIR=$rt" "WAYLAND_DISPLAY=$b_wl" "HYPRLAND_INSTANCE_SIGNATURE=$b_sig" >"$work/env-pointer"
: >"$work/pointer.log"
scoped_stdin=$work/pointer.in scoped pointer "$work/env-pointer" "$work/nested-pointer" "$live_sig" "$b_sig" "$live_wl" "$b_wl"
wait_for 5 'grep -q ready "$work/pointer.log"' || fail "the nested pointer did not start"
layout_w=2880 layout_h=1000
pointer() {
  local n
  n=$(wc -l <"$work/pointer.log")
  echo "$*" >&7
  wait_for 3 '(($(wc -l <"$work/pointer.log") > n))' || fail "the nested pointer did not answer"
}
pointer_at=""
move_to() { pointer "move $1 $2 $layout_w $layout_h"; pointer_at="$1 $2"; }
click() { move_to "$1" "$2"; sleep 0.1; pointer down; sleep 0.05; pointer up; sleep 0.4; }
drag() { # x1 y1 x2 y2 [mid-capture]
  move_to "$1" "$2"; sleep 0.1; pointer down; sleep 0.05
  local i steps=10
  for ((i = 1; i <= steps; i++)); do
    move_to $(($1 + ($3 - $1) * i / steps)) $(($2 + ($4 - $2) * i / steps))
    sleep 0.03
  done
  sleep 0.25
  [[ -n ${5:-} ]] && capture "$5"
  pointer up
  sleep 0.6
}
# Parked in a corner the pointer stays out of captures; moving there can
# move focus, so let the window borders finish their colour change.
park() {
  [[ $pointer_at == "1599 999" ]] && return 0
  move_to 1599 999
  sleep 1.2
}

# ------------------------------------------------------------- scenes

state_file=$rt/sotto/dictation-state.json
write_state() { # state kept detail edge since-ago-ms
  local now detail=null
  now=$(date +%s%3N)
  [[ -n ${3:-} ]] && detail=$(jq -Rn --arg d "$3" '$d')
  printf '{"version":1,"state":"%s","since":%s,"updatedAt":%s,"detail":%s,"kept":%s,"edge":"%s"}\n' \
    "$1" $((now - ${5:-0})) "$now" "$detail" "${2:-false}" "${4:-top}" >"$rt/sotto/.state.tmp"
  mv "$rt/sotto/.state.tmp" "$state_file"
}
go_idle() { rm -f "$state_file"; sleep 1.5; }
capture() { WAYLAND_DISPLAY=$b_wl grim -o "${2:-WAYLAND-1}" "$out/raw/$1.png"; }
pcapture() { park; capture "$@"; }
baseline() {
  hypr_b dismissnotify >/dev/null
  go_idle
  pcapture "base-${1:-WAYLAND-1}" "${1:-WAYLAND-1}"
}
# The pill's bounds: what differs from the idle baseline outside the bar's
# strip. The terminals hold still while scenes run, and anything smaller than
# the pill's 44 px thickness is the pointer.
strip_x=0 strip_y=27
pill() { # capture [output]
  magick "$out/raw/base-${2:-WAYLAND-1}.png" "$out/raw/$1.png" -compose difference -composite -crop "+$strip_x+$strip_y" +repage \
    -colorspace gray -threshold 6% -format '%@' info: 2>/dev/null |
    sed -nE 's/^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$/\1 \2 \3 \4/p' |
    awk -v dx="$strip_x" -v dy="$strip_y" '$1 > 30 && $2 > 30 {print $1, $2, $3 + dx, $4 + dy}'
}
near() { (($1 - $2 <= 2 && $2 - $1 <= 2)); }
last_verb() { tail -n1 "$work/verbs.log" | cut -f2; }
last_runner() { tail -n1 "$work/verbs.log" | cut -f1; }
verbs() { wc -l <"$work/verbs.log"; }

# Two terminals under the pill, as a desktop has: the install's output and
# the plugin's manifest. They hold still while scenes run; a last capture
# lists the verbs the stand-ins received.
printf '%s\n' "HOME=$home" "LANG=en_US.UTF-8" "PATH=/usr/bin:/bin" "XDG_CONFIG_HOME=$home/.config" \
  "XDG_RUNTIME_DIR=$rt" "WAYLAND_DISPLAY=$b_wl" "HYPRLAND_INSTANCE_SIGNATURE=$b_sig" >"$work/env-foot"
start_terminals() {
  move_to 800 500
  scoped foot-install "$work/env-foot" foot -T install sh -c 'cat "$1"; echo; echo "\$ jq .bar.layout.center shell.json"; jq -M -c ".bar.layout.center[]" "$2"; exec sleep infinity' sh "$work/install.out" "$config"
  wait_for 10 '[[ $(hypr_b clients -j | jq "map(select(.title == \"install\")) | length") == 1 ]]' || fail "the first terminal did not open"
  scoped foot-manifest "$work/env-foot" foot -T manifest sh -c 'echo "\$ jq . sotto.dictation/manifest.json"; jq -M . "$1"; exec sleep infinity' sh "$omarchy_dir/shell-plugin/sotto.dictation/manifest.json"
  wait_for 10 '[[ $(hypr_b clients -j | jq "map(select(.title == \"manifest\")) | length") == 1 ]]' || fail "the second terminal did not open"
  sleep 1
}
stop_terminals() {
  systemctl --user stop "sotto-shell-proof-$token-*-foot-*.scope" 2>/dev/null || true
  wait_for 5 '[[ $(hypr_b clients -j | jq "map(select(.title == \"install\" or .title == \"manifest\")) | length") == 0 ]]'
}

say "--- install"
in_shell bash "$omarchy_dir/install-shell-plugin.sh" --command "$checkout_sotto" >"$work/install.out" 2>&1 || {
  cat "$work/install.out"
  fail "install-shell-plugin.sh failed"
}
sed 's/^/  install: /' "$work/install.out" | tee -a "$out/proof.txt"
check '[[ -f $home/.config/omarchy/plugins/sotto.dictation/manifest.json ]]' "the plugin was copied to the isolated plugins folder"
check '[[ $(find "$home/.config/omarchy/plugins" -mindepth 1 -maxdepth 1 | wc -l) == 1 ]]' "no staging folder was left behind"
check '[[ $(jq -r ".bar.layout.center | map(.id) | index(\"sotto.dictation\") - index(\"omarchy.indicators\")" "$config") == 1 ]]' "the glyph sits right after Omarchy's indicators"
check '[[ $(jq -r ".bar.layout.center[] | select(.id == \"sotto.dictation\") | .command" "$config") == "$checkout_sotto" ]]' "the command setting names the checkout launcher"
check 'in_shell omarchy-shell shell listPlugins | jq -e "any(.[]; .id == \"sotto.dictation\" and .enabled)" >/dev/null' "the shell lists sotto.dictation as enabled"
start_terminals

say "--- states, Tokyo Night"
baseline
capture idle
for scene in "starting false - top 0" "listening false - top 12000" "transcribing false - top 0" "copied false - top 0" \
  "failed true OpenRouter_has_no_credit_left._Add_credit,_then_try_again. top 0" "failed false - top 0"; do
  read -r st kept detail edge ago <<<"$scene"
  [[ $detail == - ]] && detail="" || detail=${detail//_/ }
  write_state "$st" "$kept" "$detail" "$edge" "$ago"
  sleep 1
  name=$st
  [[ $st == failed ]] && name=failed-$([[ $kept == true ]] && echo kept || echo plain)
  pcapture "$name"
  read -r w h x y <<<"$(pill "$name")"
  check 'near "$y" 31 && near "$x" $(((1600 - w) / 2)) && near "$h" 44' "$name: the pill is centred under the bar (${w}x${h} at $x,$y)"
done
write_state delivered false "" top 0
sleep 0.6
pcapture delivered
check '[[ -n $(pill delivered) ]]' "delivered: the pill shows Pasted"
sleep 1.6
pcapture delivered-later
check '[[ -z $(pill delivered-later) ]]' "delivered: the pill is gone after its hold"

say "--- the bar glyph"
baseline
write_state transcribing
sleep 1
pcapture bar-transcribing
read -r gw gh gx gy <<<"$(magick "$out/raw/base-WAYLAND-1.png" "$out/raw/bar-transcribing.png" -compose difference -composite \
  -crop 1600x26+0+0 +repage -colorspace gray -threshold 6% -format '%@' info: | sed -E 's/^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$/\1 \2 \3 \4/')"
glyph_x=$((gx + gw / 2)) glyph_y=$((gy + gh / 2))
go_idle
n=$(verbs)
click "$glyph_x" "$glyph_y"
check '[[ $(verbs) == $((n + 1)) && $(last_verb) == "dictation toggle" && $(last_runner) == "$checkout_sotto" ]]' "a click on the bar glyph runs: $checkout_sotto dictation toggle"

say "--- the pill's buttons"
baseline
write_state listening false "" top 12000
sleep 1
pcapture buttons
read -r w h x y <<<"$(pill buttons)"
focused() { hypr_b activewindow -j | jq -r .address; }
terminal=$(hypr_b clients -j | jq -r '.[] | select(.title == "install") | .address')
hypr_b dispatch "hl.dsp.focus({ window = \"address:$terminal\" })" >/dev/null
sleep 0.3
n=$(verbs)
click $((x + w - 44)) $((y + h / 2))
check '[[ $(last_verb) == "dictation cancel" ]]' "Cancel runs: sotto dictation cancel"
click $((x + w - 103)) $((y + h / 2))
check '[[ $(last_verb) == "dictation stop" ]]' "Stop runs: sotto dictation stop"
check '[[ $(focused) == "$terminal" ]]' "the focused terminal keeps keyboard focus after the pill's buttons are pressed"
check '[[ $(hypr_b layers -j | jq -r ".\"WAYLAND-1\".levels.\"3\" | map(.namespace) | index(\"sotto-dictation\")") != null ]]' "the pill is a layer-shell surface on the overlay layer"
# Focus moved for that check, so measure against a fresh baseline.
baseline
write_state failed true "Sotto could not reach OpenRouter. Check your connection." top 0
sleep 1
pcapture buttons-failed
read -r w h x y <<<"$(pill buttons-failed)"
click $((x + w - 47)) $((y + h / 2))
check '[[ $(last_verb) == "dictation discard" ]]' "Discard runs: sotto dictation discard"
click $((x + w - 126)) $((y + h / 2))
check '[[ $(last_verb) == "dictation retry" ]]' "Try again runs: sotto dictation retry"
baseline
write_state failed false "" top 0
sleep 1
pcapture dismiss-before
read -r w h x y <<<"$(pill dismiss-before)"
n=$(verbs)
click $((x + w - 47)) $((y + h / 2))
pcapture dismiss-after
check '[[ -z $(pill dismiss-after) && $(verbs) == "$n" ]]' "Dismiss puts a failure away in the plugin and runs nothing"

say "--- drag and snap"
baseline
write_state listening false "" top 12000
sleep 1
pcapture drag-start
read -r w h x y <<<"$(pill drag-start)"
expect_edge() { # capture edge
  read -r w h x y <<<"$(pill "$1")"
  case $2 in
    top) near "$y" 31 && near "$x" $(((1600 - w) / 2)) && ((w > h)) ;;
    bottom) near "$y" $((1000 - h - 5)) && near "$x" $(((1600 - w) / 2)) && ((w > h)) ;;
    left) near "$x" 5 && near "$y" $((26 + (974 - h) / 2)) && ((h > w)) ;;
    right) near "$x" $((1600 - w - 5)) && near "$y" $((26 + (974 - h) / 2)) && ((h > w)) ;;
  esac
}
grip() { # where to hold the pill: its glyph, at the start of its length
  if ((w > h)); then echo "$((x + 24)) $((y + h / 2))"; else echo "$((x + w / 2)) $((y + 24))"; fi
}
for leg in "left 160 520" "bottom 800 930" "right 1500 520" "top 820 90"; do
  read -r edge tx ty <<<"$leg"
  read -r gx gy <<<"$(grip)"
  drag "$gx" "$gy" "$tx" "$ty" "drag-to-$edge"
  pcapture "snapped-$edge"
  check 'expect_edge "snapped-$edge" "$edge" && [[ $(last_verb) == "dictation place $edge" ]]' "drag to the $edge: the pill snaps centred on that edge and runs: sotto dictation place $edge"
done

say "--- upright buttons"
baseline
write_state listening false "" left 12000
sleep 1
pcapture upright
check 'expect_edge upright left' "Sotto's saved edge (left) places a new dictation's pill"
read -r w h x y <<<"$(pill upright)"
click $((x + w / 2)) $((y + h - 44))
check '[[ $(last_verb) == "dictation cancel" ]]' "upright Cancel runs: sotto dictation cancel"
click $((x + w / 2)) $((y + h - 103))
check '[[ $(last_verb) == "dictation stop" ]]' "upright Stop runs: sotto dictation stop"

say "--- notices"
baseline
in_shell omarchy bar set sotto.dictation command /nonexistent/sotto >/dev/null
sleep 1
click "$glyph_x" "$glyph_y"
pcapture notice-missing
check '[[ -n $(pill notice-missing) ]]' "a command that cannot run shows a notice while idle"
write_state starting false "" top 0
sleep 0.8
pcapture notice-cleared
read -r w h x y <<<"$(pill notice-cleared)"
check '((w < 400))' "a new dictation replaces the notice at once"
in_shell omarchy bar set sotto.dictation command "$work/failing/sotto" >/dev/null
sleep 1
write_state listening false "" top 3000
sleep 1
pcapture notice-before
read -r w h x y <<<"$(pill notice-before)"
click $((x + w - 103)) $((y + h / 2))
pcapture notice-unanswered
check '[[ $(last_runner) == "$work/failing/sotto" && $(last_verb) == "dictation stop" ]]' "the failing stand-in received: dictation stop"
read -r w h x y <<<"$(pill notice-unanswered)"
check '((w > 400))' "an unanswered Stop shows a notice"
sleep 5.5
pcapture notice-after
check '[[ -z $(pill notice-after) ]]' "after the notice the unanswered dictation is put away"
in_shell omarchy bar set sotto.dictation command "$checkout_sotto" >/dev/null

say "--- rule A: the display focused when dictation starts"
# Both baselines with the pointer on the second display, where a dictation
# will start, so the first display's baseline has no pointer in it.
hypr_b dismissnotify >/dev/null
go_idle
move_to 2240 420
sleep 1.2
capture base-WAYLAND-1 WAYLAND-1
capture base-WAYLAND-2 WAYLAND-2
check '[[ $(hypr_b monitors -j | jq -r ".[] | select(.focused) | .name") == WAYLAND-2 ]]' "the pointer on the second display focuses it"
write_state starting false "" top 0
sleep 0.4
write_state listening false "" top 400
sleep 1.2
capture rule-a-start-1 WAYLAND-1
capture rule-a-start-2 WAYLAND-2
check '[[ -z $(pill rule-a-start-1 WAYLAND-1) && -n $(pill rule-a-start-2 WAYLAND-2) ]]' "the pill opens on the focused second display only"
# Back over the terminal the baseline had focused, so only the pill differs.
move_to 1300 600
sleep 1.2
check '[[ $(hypr_b monitors -j | jq -r ".[] | select(.focused) | .name") == WAYLAND-1 ]]' "the pointer moves focus back to the first display mid-dictation"
capture rule-a-moved-1 WAYLAND-1
capture rule-a-moved-2 WAYLAND-2
check '[[ -z $(pill rule-a-moved-1 WAYLAND-1) && -n $(pill rule-a-moved-2 WAYLAND-2) ]]' "the pill stays on the display it opened on until dictation ends"
go_idle
write_state listening false "" top 2000
sleep 1.2
capture rule-a-next-1 WAYLAND-1
capture rule-a-next-2 WAYLAND-2
check '[[ -n $(pill rule-a-next-1 WAYLAND-1) && -z $(pill rule-a-next-2 WAYLAND-2) ]]' "the next dictation opens on the newly focused first display"

say "--- a bar on the left edge"
in_shell omarchy bar position left >/dev/null
strip_x=29 strip_y=0
sleep 1.5
baseline
write_state listening false "" top 12000
sleep 1
pcapture bar-left-top
read -r w h x y <<<"$(pill bar-left-top)"
check 'near "$y" 5 && near "$x" $((28 + (1572 - w) / 2))' "with the bar on the left, the top pill sits 5 px from the top, centred beside the bar (${w}x${h} at $x,$y)"
go_idle
write_state listening false "" left 12000
sleep 1
pcapture bar-left-left
read -r w h x y <<<"$(pill bar-left-left)"
check 'near "$x" 33 && near "$y" $(((1000 - h) / 2))' "with the bar on the left, a left-edge pill keeps clear of the bar (${w}x${h} at $x,$y)"
go_idle
in_shell omarchy bar position top >/dev/null
strip_x=0 strip_y=27
sleep 1.5

say "--- without motion"
hypr_b eval 'hl.config({ animations = { enabled = false } })' >/dev/null
baseline
write_state listening false "" top 12000
sleep 1
pcapture still-listening
write_state transcribing
sleep 1
pcapture still-transcribing
hypr_b eval 'hl.config({ animations = { enabled = true } })' >/dev/null
read -r w h x y <<<"$(pill still-transcribing)"
read -r w2 h2 x2 y2 <<<"$(pill transcribing)"
check '((w < w2))' "with Hyprland's animations off, the transcribing pill drops its travelling track"

say "--- Catppuccin Latte"
make_theme catppuccin-latte
current=$home/.local/state/omarchy/current/theme
background=$(readlink "$home/.local/state/omarchy/current/background")
in_shell omarchy-shell background themeTransition "" "$background" "$background" \
  "$(base64 -w0 "$current/colors.toml")" "$(base64 -w0 "$current/shell.toml")" >/dev/null
stop_terminals
start_terminals
baseline
capture light-idle
for scene in "listening false - 12000" "transcribing false - 0" "failed true Sotto_could_not_reach_OpenRouter._Check_your_connection. 0"; do
  read -r st kept detail ago <<<"$scene"
  [[ $detail == - ]] && detail="" || detail=${detail//_/ }
  write_state "$st" "$kept" "$detail" top "$ago"
  sleep 1
  pcapture "light-$st"
  check '[[ -n $(pill "light-$st") ]]' "light $st: the pill shows in the Latte palette"
done
write_state listening false "" top 12000
sleep 1
pcapture light-drag-start
read -r w h x y <<<"$(pill light-drag-start)"
drag $((x + 24)) $((y + h / 2)) 160 520
pcapture light-snapped-left
check 'expect_edge light-snapped-left left' "light: a drag to the left snaps upright"
go_idle
stop_terminals
move_to 800 500
scoped foot-verbs "$work/env-foot" foot -T verbs sh -c 'echo "Verbs the stand-in sotto launchers received:"; cut -f2 "$1" | nl -w2 -s"  "; exec sleep infinity' sh "$work/verbs.log"
wait_for 10 '[[ $(hypr_b clients -j | jq "map(select(.title == \"verbs\")) | length") == 1 ]]' || fail "the verbs terminal did not open"
sleep 1
pcapture verbs-received

say "--- uninstall"
in_shell bash "$omarchy_dir/install-shell-plugin.sh" --uninstall >"$work/uninstall.out" 2>&1 || fail "--uninstall failed"
sed 's/^/  uninstall: /' "$work/uninstall.out" | tee -a "$out/proof.txt"
check 'grep -q "^Its glyph is off the bar.$" "$work/uninstall.out"' "--uninstall says the glyph is off the bar"
check '[[ ! -e $home/.config/omarchy/plugins/sotto.dictation ]]' "--uninstall removes the plugin folder"
check '[[ $(jq -r ".bar.layout | [.left[], .center[], .right[]] | map(.id) | index(\"sotto.dictation\")" "$config") == null ]]' "--uninstall takes the glyph off the bar"

# ------------------------------------------------------------- composites

say "--- composites"
cd "$out/raw"
crop_top() { magick "$1.png" -crop 1000x90+300+0 +repage "$out/curated/.$1.png"; echo "$out/curated/.$1.png"; }
magick $(for s in idle starting listening transcribing delivered copied failed-kept failed-plain; do crop_top "$s"; done) -append "$out/curated/states-tokyo-night.png"
magick $(for s in light-idle light-listening light-transcribing light-failed; do crop_top "$s"; done) -append "$out/curated/states-catppuccin-latte.png"
magick $(for s in notice-missing notice-cleared notice-unanswered notice-after; do crop_top "$s"; done) -append "$out/curated/notices.png"
magick $(for s in still-listening still-transcribing; do crop_top "$s"; done) -append "$out/curated/without-motion.png"
magick \( drag-to-left.png snapped-left.png +append \) \( drag-to-bottom.png snapped-bottom.png +append \) \
  \( drag-to-right.png snapped-right.png +append \) \( drag-to-top.png snapped-top.png +append \) -append -resize 35% "$out/curated/drag-and-snap.png"
magick snapped-left.png -crop 120x420+0+290 +repage -filter point -resize 200% "$out/curated/upright-left.png"
for frame in start moved next; do
  magick "rule-a-$frame-1.png" "rule-a-$frame-2.png" -background black -gravity north +append "$out/curated/.rule-a-$frame.png"
done
magick "$out/curated/.rule-a-start.png" "$out/curated/.rule-a-moved.png" "$out/curated/.rule-a-next.png" -append -resize 35% "$out/curated/rule-a-two-displays.png"
cp listening.png "$out/curated/desktop-tokyo-night.png"
magick drag-to-left.png -crop 560x440+0+290 +repage "$out/curated/drag-ghost-left.png"
magick \( bar-left-top.png -crop 1000x140+300+0 +repage \) \( bar-left-left.png -crop 240x420+0+290 +repage -background black -gravity west -extent 1000x420 \) -append "$out/curated/bar-on-the-left.png"
magick verbs-received.png -crop 800x320+0+0 +repage "$out/curated/verbs-received.png"
cp light-listening.png "$out/curated/desktop-catppuccin-latte.png"
rm -f "$out"/curated/.*.png
cp "$work/verbs.log" "$out/verbs.log"
cd - >/dev/null

say "PASS: $passes checks"
