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
# at the end; one that outlives it fails the run. Only the Hyprland runtime
# folders this run's compositors made are removed.
#
# Usage, from a Sotto checkout on an Omarchy machine, in its desktop session:
#   scripts/verify-omarchy-shell-plugin.sh <out-dir>
# Needs Hyprland, quickshell, grim, ImageMagick, jq, foot, systemd --user,
# dbus-run-session and cc with the Wayland client headers. It writes into a
# folder of its own and, at the end, copies the checks (proof.txt), the raw
# captures (raw/), the composites (curated/) and the logs to <out-dir>.

set -euo pipefail

me=verify-omarchy-shell-plugin.sh
uid=$(id -u)
# The destination as given, made absolute without following any link.
dest=$(realpath -m -s -- "${1:?usage: $me <out-dir>}")

# What the copy at the end may write to. No link anywhere on the way to the
# destination or under it, since a write would follow it; nothing there but
# folders and files of this user's; and nothing inside the live session's
# own folders. Checked before anything is made and again just before the
# copy, and says what it refused.
check_dest() {
  local path="" part entry why live_dir
  local -a parts
  IFS=/ read -ra parts <<<"${dest#/}"
  for part in "${parts[@]}"; do
    path+=/$part
    if [[ -L $path ]]; then echo "$me: refusing $dest: $path is a symbolic link" >&2; return 1; fi
    [[ -e $path ]] || break
    if [[ ! -d $path ]]; then echo "$me: refusing $dest: $path is not a folder" >&2; return 1; fi
  done
  if [[ -d $dest ]]; then
    if [[ ! -O $dest ]]; then echo "$me: refusing $dest: it is not yours" >&2; return 1; fi
    if ! entry=$(find "$dest" -mindepth 1 \( -type l -o \! \( -type f -o -type d \) -o \! -user "$uid" \) -print -quit 2>/dev/null); then
      echo "$me: refusing $dest: could not look through all of it" >&2
      return 1
    fi
    if [[ -n $entry ]]; then
      if [[ -L $entry ]]; then why="is a symbolic link"
      elif [[ -O $entry ]]; then why="is not a plain file or folder"
      else why="is not yours"; fi
      echo "$me: refusing $dest: $entry $why" >&2
      return 1
    fi
  fi
  for live_dir in "$HOME/.config/omarchy" "$HOME/.config/hypr" "$HOME/.local/state/omarchy"; do
    live_dir=$(realpath -m -- "$live_dir")
    if [[ $dest == "$live_dir" || $dest == "$live_dir"/* ]]; then
      echo "$me: refusing to write into $live_dir, which the live session uses: $dest" >&2
      return 1
    fi
  done
}
check_dest || exit 2

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
omarchy_dir=$(cd -- "$here/../apps/omarchy" && pwd -P)
omarchy_path=${OMARCHY_PATH:-/usr/share/omarchy}
run=/run/user/$uid

# Everything the run writes goes under a folder it makes for itself,
# exclusively and private to this user; the evidence is copied out at the
# end. Until cleanup is armed below, an early exit just removes it.
work=$(mktemp -d /tmp/sotto-shell-proof.XXXXXX)
trap 'rm -rf -- "$work"' EXIT
evidence=$work/evidence
mkdir -m 700 "$evidence" "$evidence/raw" "$evidence/curated"
: >"$evidence/proof.txt"

say() { printf '%s\n' "$*" | tee -a "$evidence/proof.txt"; }
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
live_sig="" live_wl="" live_shell=""
for pid in $(pgrep -x quickshell || true); do
  grep -q proof "/proc/$pid/cgroup" 2>/dev/null && continue
  env_of() { tr '\0' '\n' <"/proc/$pid/environ" | sed -n "s/^$1=//p"; }
  [[ $(env_of XDG_RUNTIME_DIR) == "$run" ]] || continue
  [[ -n $live_sig ]] && fail "more than one live Omarchy shell; cannot tell which is live"
  live_sig=$(env_of HYPRLAND_INSTANCE_SIGNATURE)
  live_wl=$(env_of WAYLAND_DISPLAY)
  live_shell=$pid
done
[[ -n $live_sig && -n $live_wl ]] || fail "the live Omarchy shell was not found"
snapshot_instances() { (cd "$run/hypr" && for d in */; do stat -c '%n %i' "${d%/}"; done) | sort; }
instances_before=$(snapshot_instances)
grep -q "^$live_sig " <<<"$instances_before" || fail "the live instance folder is missing"
say "live: $live_sig on $live_wl (untouched)"
live_config_stamp=$(stat -c '%Y %s' "$HOME/.config/omarchy/shell.json" 2>/dev/null || echo none)
start_of() { # pid -> field 22 of its stat, read after the last parenthesis
  local stat
  local -a fields
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat=${stat##*) }
  read -ra fields <<<"$stat"
  echo "${fields[19]}"
}
# The live shell's long-running processes, such as its clipboard watchers, by
# PID and start time. Omarchy's clipboard service once killed those from a
# nested shell, and the live shell started them again; one that is gone or
# restarted at the end fails the run. A minute's age leaves out the short
# jobs the shell runs now and then.
live_processes() {
  local pid start
  ps -e -o pid=,ppid=,etimes= | awk -v root="$live_shell" '
    { parent[$1] = $2; age[$1] = $3 }
    END {
      for (pid in parent) {
        for (p = pid; p != "" && p != 0 && p != 1; p = parent[p]) if (p == root) { if (age[pid] >= 60) print pid; break }
      }
    }' | sort -n | while read -r pid; do
    start=$(start_of "$pid") || continue
    printf '%s %s %s\n' "$pid" "$start" "$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)"
  done
}
live_before=$(live_processes)
[[ -n $live_before ]] || fail "the live shell's processes were not found"
say "live shell: PID $live_shell, $(wc -l <<<"$live_before") long-running processes recorded"
live_plugins=$(ls -A "$HOME/.config/omarchy/plugins" 2>/dev/null || true)

# ------------------------------------------------------------- ownership

# Everything this proof starts is its own from the moment it starts: each
# process by its exact PID, in this run's slice, and each Hyprland instance
# folder by the PID in its lock. Cleanup is armed before anything is made.
token=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
slice=app-sottoshellproof$token.slice
rt="" units=0 last_pid=""
owned_pids=()
owned_folders=() # "sig inode pid" for each instance folder a compositor of ours made
a_pid="" b_pid="" a_sig="" b_sig="" a_wl="" b_wl=""

in_slice() { grep -lF "/$slice/" /proc/[0-9]*/cgroup 2>/dev/null | cut -d/ -f3 | tr '\n' ' '; }

# Takes the folder only when this run did not find it already there and its
# lock names the compositor this run started.
own_folder() { # sig pid
  local sig=$1 pid=$2 dir=$run/hypr/$1 entry
  [[ -n $sig && -n $pid && $sig != "$live_sig" && -d $dir ]] || return 1
  grep -q "^$sig " <<<"$instances_before" && return 1
  [[ $(head -n1 "$dir/hyprland.lock" 2>/dev/null) == "$pid" ]] || return 1
  for entry in "${owned_folders[@]}"; do [[ ${entry%% *} == "$sig" ]] && return 0; done
  owned_folders+=("$sig $(stat -c %i "$dir") $pid")
}

# A compositor can make its folder and then fail before hyprctl finds it,
# so its folder is also found from the PID in its lock.
recover_folders() {
  local pid dir entry found
  for pid in "$a_pid" "$b_pid"; do
    [[ -n $pid ]] || continue
    found=0
    for entry in "${owned_folders[@]}"; do [[ ${entry##* } == "$pid" ]] && found=1; done
    ((found)) && continue
    for dir in "$run"/hypr/*/; do
      own_folder "$(basename "$dir")" "$pid" && break
    done
  done
}

cleanup() {
  local status=$? left="" pid start cmd entry sig ino dir lock_pid after
  set +e
  exec 7>&- 2>/dev/null
  recover_folders
  systemctl --user stop "$slice" 2>/dev/null
  for _ in $(seq 1 50); do
    [[ -z $(in_slice) ]] && break
    sleep 0.1
  done
  left=$(in_slice)
  for pid in "${owned_pids[@]}"; do
    [[ " $left " == *" $pid "* ]] && continue
    kill -0 "$pid" 2>/dev/null && grep -qF "/$slice/" "/proc/$pid/cgroup" 2>/dev/null && left+="$pid "
  done
  if [[ -n ${left// /} ]]; then
    say "FAIL: processes outlived the proof: $left"
    systemctl --user kill --signal=SIGKILL "$slice" 2>/dev/null
    status=1
  else
    say "no process outlived the proof"
  fi
  for entry in "${owned_folders[@]}"; do
    read -r sig ino pid <<<"$entry"
    dir=$run/hypr/$sig
    [[ -d $dir ]] || continue
    if kill -0 "$pid" 2>/dev/null; then
      say "FAIL: $sig was left: its compositor, PID $pid, is still running"
      status=1
      continue
    fi
    [[ $(stat -c %i "$dir") == "$ino" ]] || { say "left $sig alone: it was replaced"; continue; }
    lock_pid=$(head -n1 "$dir/hyprland.lock" 2>/dev/null)
    [[ -z $lock_pid || $lock_pid == "$pid" ]] || { say "left $sig alone: another process holds it"; continue; }
    rm -rf -- "$dir"
  done
  after=$(snapshot_instances)
  while read -r name ino; do
    [[ -n $name ]] || continue
    # Another session's nested Hyprland may come and go meanwhile; the live
    # one must not.
    if ! grep -q "^$name $ino\$" <<<"$after"; then
      if [[ $name == "$live_sig" ]]; then say "FAIL: the live instance folder changed"; status=1
      else say "note: $name, not this proof's, changed meanwhile"; fi
    fi
  done <<<"$instances_before"
  for entry in "${owned_folders[@]}"; do
    sig=${entry%% *}
    grep -q "^$sig " <<<"$after" && { say "FAIL: $sig is still there"; status=1; }
  done
  say "instance folders after cleanup: $(cut -d' ' -f1 <<<"$after" | tr '\n' ' ')"
  if [[ $(stat -c '%Y %s' "$HOME/.config/omarchy/shell.json" 2>/dev/null || echo none) == "$live_config_stamp" ]]; then
    say "live shell.json unchanged"
  else
    say "FAIL: live shell.json changed"; status=1
  fi
  if [[ $(ls -A "$HOME/.config/omarchy/plugins" 2>/dev/null || true) == "$live_plugins" ]]; then
    say "live plugins folder unchanged"
  else
    say "FAIL: live plugins folder changed"; status=1
  fi
  left=""
  while read -r pid start cmd; do
    [[ -n $pid ]] || continue
    [[ $(start_of "$pid") == "$start" ]] || left+=$'\n'"  $pid $cmd"
  done <<<"$live_before"
  if [[ -z $left ]]; then
    say "the live shell's $(wc -l <<<"$live_before") long-running processes are the ones it had at the start"
  else
    say "FAIL: live shell processes gone or restarted during the proof:$left"; status=1
  fi
  mkdir -p "$evidence/logs"
  cp "$work"/*.log "$evidence/logs/" 2>/dev/null
  deliver || status=1
  [[ $work == /tmp/sotto-shell-proof.* ]] && rm -rf -- "$work"
  [[ $rt == /tmp/ssp-* ]] && rm -rf -- "$rt"
  exit "$status"
}
# Copies the evidence out, the destination checked again first, so a link
# that appeared there meanwhile is refused rather than followed. Existing
# files are replaced, never written through.
deliver() {
  check_dest || { echo "$me: the evidence was not copied" >&2; return 1; }
  mkdir -p -- "$dest" && check_dest || { echo "$me: the evidence was not copied" >&2; return 1; }
  cp -R --no-dereference --remove-destination -- "$evidence/." "$dest/" || return 1
  echo "evidence copied to $dest"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A short runtime folder: Hyprland's socket path must fit in 108 bytes.
rt=$(mktemp -d /tmp/ssp-XXXXXX)
home=$work/home

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
  owned_pids+=("$last_pid")
}

# Kills only a process in this run's slice, so a PID that has meanwhile gone
# to another process is refused rather than killed.
kill_owned() { # pid
  grep -qF "/$slice/" "/proc/$1/cgroup" 2>/dev/null || fail "refusing to kill PID $1, which is not in this proof's slice"
  kill -KILL "$1"
}

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
[[ $a_sig != "$live_sig" && $a_wl != "$live_wl" ]] || fail "A is the live instance"
own_folder "$a_sig" "$a_pid" || fail "A's instance folder is not one this proof can own"

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
own_folder "$b_sig" "$b_pid" || fail "B's instance folder is not one this proof can own"
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
# Clipboard.qml starts by killing every matching clipboard watcher, including
# the live shell's. Never load that unrelated service in a nested proof. The
# battery service sets the system's power profile when the power source
# changes, which the live shell does already.
jq '.disabledPlugins = ((.disabledPlugins // []) + ["omarchy.polkit", "omarchy.lock", "omarchy.idle", "omarchy.nightlight", "omarchy.clipboard", "omarchy.battery"] | unique)' \
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
# failing one answers as Sotto does when it is not running. They change no
# state: the proof writes the state files itself.
mkdir -p "$work/bin" "$work/checkout/apps/omarchy" "$work/failing"
: >"$work/verbs.log"
for stub in "$work/bin/sotto" "$work/checkout/apps/omarchy/sotto"; do
  printf '#!/bin/bash\nprintf "%%s\\t%%s\\n" "$0" "$*" >>%q\n' "$work/verbs.log" >"$stub"
done
printf '#!/bin/bash\nprintf "%%s\\t%%s\\n" "$0" "$*" >>%q\necho "Sotto could not receive the dictation command." >&2\nexit 1\n' "$work/verbs.log" >"$work/failing/sotto"
chmod +x "$work/bin/sotto" "$work/checkout/apps/omarchy/sotto" "$work/failing/sotto"
checkout_sotto=$work/checkout/apps/omarchy/sotto
# A slow one holds each verb until the scene releases it, then fails, as a
# launcher stuck on a Sotto that has gone does.
mkdir -p "$work/slow"
: >"$work/slow/finished"
cat >"$work/slow/sotto" <<EOF
#!/bin/bash
printf '%s\t%s\n' "\$0" "\$*" >>$(printf %q "$work/verbs.log")
until [[ -e $(printf %q "$work/slow/release") ]]; do sleep 0.1; done
printf '%s\n' "\$*" >>$(printf %q "$work/slow/finished")
echo "Sotto could not receive the dictation command." >&2
exit 1
EOF
chmod +x "$work/slow/sotto"

# A stand-in for Sotto's main process, which every state file names in
# `pid`, with its start time in `pidStart`; the plugin checks it is alive
# while a dictation shows. Start times are read when a stand-in starts, so
# a file can still name one after it is killed.
declare -A starts=()
stand_in() { # name
  scoped "$1" "$work/env-sotto" sleep infinity
  starts[$last_pid]=$(start_of "$last_pid") || fail "the $1 stand-in did not start"
}
printf '%s\n' "PATH=/usr/bin:/bin" >"$work/env-sotto"
stand_in sotto-main
sotto_pid=$last_pid

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

cc "$here/omarchy-nested-pointer.c" -o "$work/nested-pointer" -lwayland-client -Wall -Wextra -Werror
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
# What the state files say beyond their state, as Sotto writes it unless a
# scene sets otherwise for one write:
# - `pid`, Sotto's stand-in unless `state_pid` names a stand-in the scene
#   kills, or none, as an older Sotto writes;
# - `pidStart`, that process's start time unless `state_start` gives
#   another, or none;
# - `dictation`, a new identifier after go_idle or new_dictation and the
#   same one until then, unless `state_dictation` is none;
# - and `state_mode` makes the file one the shell cannot read.
state_pid="" state_start="" state_dictation="" state_mode=""
dictations=0 dictation=""
new_dictation() { dictations=$((dictations + 1)); dictation="proof-$token-$dictations"; }
write_state() { # state kept detail edge since-ago-ms
  local now detail=null pid=${state_pid:-$sotto_pid} start=$state_start fields=""
  now=$(date +%s%3N)
  [[ -n ${3:-} ]] && detail=$(jq -Rn --arg d "$3" '$d')
  if [[ $pid != none ]]; then
    fields+=",\"pid\":$pid"
    [[ -n $start ]] || start=${starts[$pid]:-none}
    [[ $start == none ]] || fields+=",\"pidStart\":$start"
  fi
  if [[ $state_dictation != none ]]; then
    [[ -n $dictation ]] || new_dictation
    fields+=",\"dictation\":\"$dictation\""
  fi
  printf '{"version":1,"state":"%s","since":%s,"updatedAt":%s,"detail":%s,"kept":%s,"edge":"%s"%s}\n' \
    "$1" $((now - ${5:-0})) "$now" "$detail" "${2:-false}" "${4:-top}" "$fields" >"$rt/sotto/.state.tmp"
  [[ -z $state_mode ]] || chmod "$state_mode" "$rt/sotto/.state.tmp"
  mv "$rt/sotto/.state.tmp" "$state_file"
}
go_idle() { rm -f "$state_file"; dictation=""; sleep 1.5; }
capture() { WAYLAND_DISPLAY=$b_wl grim -o "${2:-WAYLAND-1}" "$evidence/raw/$1.png"; }
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
  magick "$evidence/raw/base-${2:-WAYLAND-1}.png" "$evidence/raw/$1.png" -compose difference -composite -crop "+$strip_x+$strip_y" +repage \
    -colorspace gray -threshold 6% -format '%@' info: 2>/dev/null |
    sed -nE 's/^([0-9]+)x([0-9]+)\+([0-9]+)\+([0-9]+)$/\1 \2 \3 \4/p' |
    awk -v dx="$strip_x" -v dy="$strip_y" '$1 > 30 && $2 > 30 {print $1, $2, $3 + dx, $4 + dy}'
}
# Whether the bar glyph differs from the idle baseline, in a box around it
# that keeps the clock out.
glyph_changed() { # capture
  local mean
  mean=$(magick "$evidence/raw/base-WAYLAND-1.png" "$evidence/raw/$1.png" -compose difference -composite \
    -crop "40x26+$((glyph_x - 20))+0" +repage -colorspace gray -threshold 6% -format '%[fx:mean]' info:)
  awk -v m="$mean" 'BEGIN { exit !(m > 0.02) }'
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
# XDG_CONFIG_HOME points away from ~/.config and holds a stray copy, which
# the shell never loads; the script installs where the shell looks.
elsewhere=$home/xdg-elsewhere
mkdir -p "$elsewhere/omarchy/plugins/sotto.dictation"
cp "$omarchy_dir/shell-plugin/sotto.dictation/manifest.json" "$elsewhere/omarchy/plugins/sotto.dictation/"
in_shell env XDG_CONFIG_HOME="$elsewhere" bash "$omarchy_dir/install-shell-plugin.sh" --command "$checkout_sotto" >"$work/install.out" 2>&1 || {
  cat "$work/install.out"
  fail "install-shell-plugin.sh failed"
}
sed 's/^/  install: /' "$work/install.out" | tee -a "$evidence/proof.txt"
check '[[ -f $home/.config/omarchy/plugins/sotto.dictation/manifest.json && ! -e $home/.config/omarchy/plugins/sotto.dictation/Model.d.mts ]]' "the plugin was copied to \$HOME/.config/omarchy/plugins whatever XDG_CONFIG_HOME says, without the tests' types"
check 'grep -q "^There is another copy of the plugin in $elsewhere/" "$work/install.out"' "the script says a copy under XDG_CONFIG_HOME is not loaded"
check '[[ $(find "$home/.config/omarchy/plugins" -mindepth 1 -maxdepth 1 | wc -l) == 1 ]]' "no staging folder was left behind"
check '[[ $(jq -r ".bar.layout.center | map(.id) | index(\"sotto.dictation\") - index(\"omarchy.indicators\")" "$config") == 1 ]]' "the glyph sits right after Omarchy's indicators"
check '[[ $(jq -r ".bar.layout.center[] | select(.id == \"sotto.dictation\") | .command" "$config") == "$checkout_sotto" ]]' "the command setting names the checkout launcher"
check 'in_shell omarchy-shell shell listPlugins | jq -e "any(.[]; .id == \"sotto.dictation\" and .enabled)" >/dev/null' "the shell lists sotto.dictation as enabled"
start_terminals

say "--- states, Tokyo Night"
baseline
capture idle
for scene in "starting false - top 0" "listening false - top 12000" "transcribing false - top 0" "copied false - top 0" \
  "failed true The_transcription_service_is_busy._Recording_kept. top 0" "failed false - top 0"; do
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
read -r gw gh gx gy <<<"$(magick "$evidence/raw/base-WAYLAND-1.png" "$evidence/raw/bar-transcribing.png" -compose difference -composite \
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
write_state failed true "Sotto could not reach OpenRouter. Recording kept." top 0
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

say "--- a Stop that does not get through"
in_shell omarchy bar set sotto.dictation command "$work/failing/sotto" >/dev/null
sleep 1
baseline
write_state listening false "" top 3000
sleep 1
pcapture stop-before
read -r w h x y <<<"$(pill stop-before)"
click $((x + w - 103)) $((y + h / 2))
pcapture stop-failed
check '[[ $(last_runner) == "$work/failing/sotto" && $(last_verb) == "dictation stop" ]]' "the failing stand-in received: dictation stop"
read -r w h x y <<<"$(pill stop-failed)"
check '((h > 44))' "a Stop that does not get through says so in the pill, on two lines (${w}x${h} at $x,$y)"
sleep 5.5
pcapture stop-failed-later
check '[[ $(pill stop-failed-later) == "$w $h $x $y" ]]' "six seconds later the pill, its words and its buttons are still there"
click $((x + w - 44)) $((y + h / 2))
pcapture cancel-failed
check '[[ $(last_verb) == "dictation cancel" && -n $(pill cancel-failed) ]]' "its Cancel can still be pressed, and a Cancel that does not get through keeps the pill too"
in_shell omarchy bar set sotto.dictation command "$checkout_sotto" >/dev/null
sleep 1
read -r w h x y <<<"$(pill cancel-failed)"
click $((x + w - 103)) $((y + h / 2))
check '[[ $(last_runner) == "$checkout_sotto" && $(last_verb) == "dictation stop" ]]' "once the command works again, Stop reaches Sotto"

say "--- Sotto quits"
# A second stand-in, which this scene kills as a crash would.
stand_in sotto-crash
crash_pid=$last_pid
baseline
state_pid=$crash_pid write_state listening false "" top 8000
sleep 1
pcapture crash-before
read -r w h x y <<<"$(pill crash-before)"
check '[[ -n $w ]] && ((w < 400))' "a dictation shows while the Sotto it names runs (PID $crash_pid)"
kill_owned "$crash_pid"
wait_for 3 '! kill -0 "$crash_pid" 2>/dev/null' || fail "the crash stand-in did not stop"
sleep 3.5
pcapture crash-listening
read -r w h x y <<<"$(pill crash-listening)"
check '((h > 44))' "within a few seconds of Sotto quitting, the pill says the dictation was lost (${w}x${h})"
n=$(verbs)
click $((x + w - 47)) $((y + h / 2))
pcapture crash-dismissed
check '[[ -z $(pill crash-dismissed) && $(verbs) == "$n" ]]' "its Dismiss puts the notice away and runs nothing"
state_pid=$crash_pid write_state failed true "The transcription service is busy. Recording kept." top 0
sleep 3.5
pcapture crash-kept
read -r w h x y <<<"$(pill crash-kept)"
n=$(verbs)
click $((x + w - 47)) $((y + h / 2))
pcapture crash-kept-dismissed
check '[[ -n $w && -z $(pill crash-kept-dismissed) && $(verbs) == "$n" ]]' "a kept recording whose Sotto has quit is shown as lost, with Dismiss rather than Discard (${w}x${h})"
# Sotto's PID taken by another process: the file names a running process,
# but one that started at another time, from the first read.
baseline
state_start=$((${starts[$sotto_pid]} + 1)) write_state listening false "" top 8000
sleep 3.5
pcapture crash-reused
read -r w h x y <<<"$(pill crash-reused)"
check '[[ -n $w ]] && ((h > 44))' "a file whose PID now belongs to a process started at another time says Sotto quit, from its first read (${w}x${h})"
check 'kill -0 "$sotto_pid"' "the process with that PID is still running"
baseline
state_start=none write_state listening false "" top 8000
sleep 4.5
pcapture pid-alone
read -r w h x y <<<"$(pill pid-alone)"
check '[[ -n $w ]] && ((w < 400))' "a state file with pid and no pidStart is checked by its PID alone"
baseline
state_pid=none state_dictation=none write_state listening false "" top 8000
sleep 4.5
pcapture older-sotto
read -r w h x y <<<"$(pill older-sotto)"
check '[[ -n $w ]] && ((w < 400))' "a state file without pid, from an older Sotto, is taken at its word"

say "--- a state file that cannot be read"
baseline
write_state listening false "" top 8000
sleep 1
pcapture unreadable-before
read -r w0 h0 x0 y0 <<<"$(pill unreadable-before)"
state_mode=000 write_state listening false "" top 8000
sleep 1.5
pcapture unreadable
read -r w h x y <<<"$(pill unreadable)"
check '[[ -n $w ]] && ((w > w0 + 100))' "a state file that cannot be read keeps the pill and its buttons, and says so (${w}x${h} at $x,$y)"
n=$(verbs)
click $((x + w - 103)) $((y + h / 2))
check '[[ $(verbs) == $((n + 1)) && $(last_verb) == "dictation stop" ]]' "its Stop still runs: sotto dictation stop"
sleep 4
pcapture unreadable-later
check '[[ $(pill unreadable-later) == "$w $h $x $y" ]]' "five seconds later the pill and its notice are still there"
write_state listening false "" top 8000
sleep 3.5
pcapture unreadable-recovered
read -r w h x y <<<"$(pill unreadable-recovered)"
check '[[ -n $w ]] && near "$w" "$w0"' "once the file can be read again, the notice goes and the dictation shows as before (${w}x${h})"
# Sotto quitting while the file cannot be read: the plugin still checks it.
stand_in sotto-unreadable
gone_pid=$last_pid
state_pid=$gone_pid write_state listening false "" top 8000
sleep 1
state_pid=$gone_pid state_mode=000 write_state listening false "" top 8000
sleep 1.5
kill_owned "$gone_pid"
wait_for 3 '! kill -0 "$gone_pid" 2>/dev/null' || fail "the stand-in did not stop"
sleep 3.5
pcapture unreadable-quit
read -r w h x y <<<"$(pill unreadable-quit)"
check '[[ -n $w ]] && ((h > 44))' "when Sotto quits while its file cannot be read, the pill says the dictation was lost (${w}x${h})"
click $((x + w - 47)) $((y + h / 2))
pcapture unreadable-dismissed
check '[[ -z $(pill unreadable-dismissed) ]] && glyph_changed unreadable-dismissed' "after Dismiss no pill shows, and the glyph still says the file cannot be read"
# A file that cannot be read from the first, with nothing on screen.
rm -f "$state_file"
sleep 3.5
dictation=""
pcapture unreadable-cleared
check '! glyph_changed unreadable-cleared' "once the file is gone, the glyph is back at rest"
state_mode=000 write_state listening false "" top 8000
sleep 1.5
pcapture unreadable-first
check '[[ -z $(pill unreadable-first) ]] && glyph_changed unreadable-first' "a file that cannot be read from the first shows no pill, only the glyph in the urgent colour"
rm -f "$state_file"
dictation=""
sleep 3.5

say "--- a Stop that fails after Sotto quit"
# Stop is pressed with the slow launcher, Sotto quits while it holds, and
# the plugin says so; then the Stop fails. That late failure must leave
# "Sotto quit" and its Dismiss as they are, with the state file readable
# or not, and must bring nothing back once that notice is dismissed.
in_shell omarchy bar set sotto.dictation command "$work/slow/sotto" >/dev/null
sleep 1
same_pill() { # capture capture x y w h: no pixel differs inside those bounds
  local diff
  diff=$(magick compare -metric AE -fuzz 2% \( "$evidence/raw/$1.png" -crop "${5}x${6}+${3}+${4}" +repage \) \
    \( "$evidence/raw/$2.png" -crop "${5}x${6}+${3}+${4}" +repage \) null: 2>&1 >/dev/null)
  [[ ${diff%% *} == 0 ]]
}
for variant in readable unreadable dismissed; do
  rm -f "$work/slow/release"
  stand_in "sotto-late-$variant"
  late_pid=$last_pid
  baseline
  state_pid=$late_pid write_state listening false "" top 8000
  sleep 1
  if [[ $variant == unreadable ]]; then
    state_pid=$late_pid state_mode=000 write_state listening false "" top 8000
    sleep 1.5
  fi
  pcapture "late-$variant-before"
  read -r w h x y <<<"$(pill "late-$variant-before")"
  finished=$(wc -l <"$work/slow/finished")
  click $((x + w - 103)) $((y + h / 2))
  wait_for 3 '[[ $(last_runner) == "$work/slow/sotto" && $(last_verb) == "dictation stop" ]]'
  check '[[ $(last_runner) == "$work/slow/sotto" && $(last_verb) == "dictation stop" ]]' "$variant: Stop runs the slow launcher, which holds"
  kill_owned "$late_pid"
  wait_for 3 '! kill -0 "$late_pid" 2>/dev/null' || fail "the stand-in did not stop"
  sleep 3.5
  pcapture "late-$variant-lost"
  read -r lw lh lx ly <<<"$(pill "late-$variant-lost")"
  check '[[ -n $lw ]] && ((lh > 44)) && [[ $(wc -l <"$work/slow/finished") == "$finished" ]]' "$variant: the pill says Sotto quit while that Stop still runs (${lw}x${lh} at $lx,$ly)"
  [[ $variant == dismissed ]] && click $((lx + lw - 47)) $((ly + lh / 2))
  touch "$work/slow/release"
  wait_for 3 '(($(wc -l <"$work/slow/finished") > finished))' || fail "the slow launcher did not finish"
  sleep 1
  pcapture "late-$variant-failed"
  if [[ $variant == dismissed ]]; then
    check '[[ -z $(pill late-dismissed-failed) ]]' "dismissed: once Sotto quit is dismissed, the Stop failing after it brings no notice back"
  else
    check '[[ $(pill "late-$variant-failed") == "$lw $lh $lx $ly" ]] && same_pill "late-$variant-lost" "late-$variant-failed" "$lx" "$ly" "$lw" "$lh"' "$variant: the Stop failing after it leaves Sotto quit and its Dismiss as they were"
    sleep 5.5
    pcapture "late-$variant-later"
    check 'same_pill "late-$variant-lost" "late-$variant-later" "$lx" "$ly" "$lw" "$lh"' "$variant: six and a half seconds later the notice is still there"
    n=$(verbs)
    click $((lx + lw - 47)) $((ly + lh / 2))
    pcapture "late-$variant-dismissed"
    check '[[ -z $(pill "late-$variant-dismissed") && $(verbs) == "$n" ]]' "$variant: its Dismiss puts it away and runs nothing"
  fi
  rm -f "$state_file"
  dictation=""
  sleep 3.5
done
in_shell omarchy bar set sotto.dictation command "$checkout_sotto" >/dev/null
sleep 1

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

say "--- rule A: a new dictation while the last one's result shows"
# Baselines with the pointer on the second display, where it is when the
# captures are taken.
hypr_b dismissnotify >/dev/null
go_idle
move_to 2240 420
sleep 1.2
capture base-WAYLAND-1 WAYLAND-1
capture base-WAYLAND-2 WAYLAND-2
for previous in copied kept; do
  move_to 1300 600
  sleep 1.2
  write_state listening false "" top 2000
  sleep 0.6
  if [[ $previous == copied ]]; then
    write_state copied false "" top 0
  else
    write_state failed true "The transcription service is busy. Recording kept." top 0
  fi
  sleep 0.3
  move_to 2240 420
  sleep 1.2
  capture "$previous-shows-1" WAYLAND-1
  capture "$previous-shows-2" WAYLAND-2
  check '[[ -n $(pill "$previous-shows-1" WAYLAND-1) && -z $(pill "$previous-shows-2" WAYLAND-2) ]]' "$previous: the result shows on the first display, where its dictation started, with the pointer on the second"
  new_dictation
  write_state starting false "" top 0
  sleep 0.8
  capture "after-$previous-1" WAYLAND-1
  capture "after-$previous-2" WAYLAND-2
  check '[[ -z $(pill "after-$previous-1" WAYLAND-1) && -n $(pill "after-$previous-2" WAYLAND-2) ]]' "$previous: a new dictation started meanwhile opens on the focused second display"
  go_idle
done
# Sotto quitting while the pointer is on the other display: the notice
# stays where the dictation was, rather than reopening where focus is.
stand_in sotto-crash-elsewhere
crash_pid=$last_pid
move_to 1300 600
sleep 1.2
state_pid=$crash_pid write_state listening false "" top 2000
sleep 0.6
move_to 2240 420
sleep 1.2
kill_owned "$crash_pid"
wait_for 3 '! kill -0 "$crash_pid" 2>/dev/null' || fail "the crash stand-in did not stop"
sleep 3.5
capture quit-elsewhere-1 WAYLAND-1
capture quit-elsewhere-2 WAYLAND-2
read -r w h x y <<<"$(pill quit-elsewhere-1 WAYLAND-1)"
check '[[ -n $w && -z $(pill quit-elsewhere-2 WAYLAND-2) ]] && ((h > 44))' "when Sotto quits, its notice stays on the display the dictation was on (${w}x${h})"
go_idle

say "--- rule A: two dictations' states written as one"
# A connects on the first display; the pointer moves to the second; A is
# cancelled as B starts, and only A's starting and B's listening are
# written, as Sotto's 50 ms coalescing can leave them. Once with Sotto's
# dictation identifiers, once without, as an older Sotto writes.
hypr_b dismissnotify >/dev/null
go_idle
move_to 2240 420
sleep 1.2
capture base-WAYLAND-1 WAYLAND-1
capture base-WAYLAND-2 WAYLAND-2
for named in named unnamed; do
  [[ $named == named ]] && state_dictation="" || state_dictation=none
  move_to 1300 600
  sleep 1.2
  new_dictation
  write_state starting false "" top 0
  sleep 0.6
  move_to 2240 420
  sleep 1.2
  capture "coalesced-$named-a-1" WAYLAND-1
  capture "coalesced-$named-a-2" WAYLAND-2
  check '[[ -n $(pill "coalesced-$named-a-1" WAYLAND-1) && -z $(pill "coalesced-$named-a-2" WAYLAND-2) ]]' "$named: A's starting shows on the first display, with the pointer now on the second"
  new_dictation
  write_state listening false "" top 0
  sleep 0.8
  capture "coalesced-$named-b-1" WAYLAND-1
  capture "coalesced-$named-b-2" WAYLAND-2
  if [[ $named == named ]]; then
    check '[[ -z $(pill coalesced-named-b-1 WAYLAND-1) && -n $(pill coalesced-named-b-2 WAYLAND-2) ]]' "B's listening, under its own identifier, opens on the focused second display"
  else
    check '[[ -n $(pill coalesced-unnamed-b-1 WAYLAND-1) && -z $(pill coalesced-unnamed-b-2 WAYLAND-2) ]]' "without identifiers, as from an older Sotto, the pair reads as one dictation and stays on the first display"
  fi
  go_idle
done
state_dictation=""

say "--- an upright failure on a small display, then a scaled one"
# B's second display shrinks to the 820x560 minimum, then becomes a full-HD
# display at 200%, 960x540 logical. Its window in A is resized to match.
set_display_2() { # width height scale
  local size=${1}x${2}
  hypr_b eval "hl.monitor({ output = \"WAYLAND-2\", mode = \"$size@60\", position = \"1600x0\", scale = $3 })" >/dev/null
  hypr_a dispatch "hl.dsp.window.resize({ x = $1, y = $2, window = \"address:$(b_window WAYLAND-2)\" })" >/dev/null
  wait_for 10 '[[ $(displays) == "WAYLAND-1=1600x1000@0 WAYLAND-2=$size@1600" ]]' || fail "B's second display did not become $size: $(displays)"
  layout_w=$((1600 + $1 / $3))
  hypr_b dismissnotify >/dev/null
}
# Sotto's longest kept failure, from the plumbing branch's sentences.
longest="Text could not be delivered. Recording kept. Open Sotto."
for spec in small:820:560:1 scaled:1920:1080:2; do
  IFS=: read -r name dw dh scale <<<"$spec"
  set_display_2 "$dw" "$dh" "$scale"
  go_idle
  # Parked at the display's far corner, away from a left-edge pill.
  move_to $((layout_w - 10)) $((dh / scale - 10))
  sleep 1.2
  check '[[ $(hypr_b monitors -j | jq -r ".[] | select(.focused) | .name") == WAYLAND-2 ]]' "$name: the pointer focuses the ${dw}x${dh} display at ${scale}x"
  capture base-WAYLAND-2 WAYLAND-2
  write_state failed true "$longest" left 0
  sleep 1
  capture "$name-upright" WAYLAND-2
  strip_y=$((27 * scale))
  read -r w h x y <<<"$(pill "$name-upright" WAYLAND-2)"
  strip_y=27
  bar=$((26 * scale)) gap=$((5 * scale))
  check '[[ -n $w ]] && near "$x" "$gap" && ((h > w && y >= bar && y + h <= dh - gap + 1))' "$name: the upright failure pill fits the display beside the bar, buttons and all (${w}x${h} at $x,$y of ${dw}x${dh})"
  click $((1600 + (x + w / 2) / scale)) $(((y + h) / scale - 47))
  check '[[ $(last_verb) == "dictation discard" ]]' "$name: its Discard is on screen and runs: sotto dictation discard"
  go_idle
done
set_display_2 1280 800 1

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
for scene in "listening false - 12000" "transcribing false - 0" "failed true Sotto_could_not_reach_OpenRouter._Recording_kept. 0"; do
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
plugin_dir=$home/.config/omarchy/plugins/sotto.dictation
on_bar() { jq -e '[.bar.layout | .left[], .center[], .right[]] | map(.id) | index("sotto.dictation") != null' "$config" >/dev/null; }
uninstall() { # name [env assignment]
  local name=$1
  shift
  in_shell env "$@" bash "$omarchy_dir/install-shell-plugin.sh" --uninstall >"$work/$name.out" 2>&1
  local status=$?
  sed "s/^/  $name: /" "$work/$name.out" | tee -a "$evidence/proof.txt"
  return "$status"
}
mkdir -m 700 "$work/no-shell"
check '! uninstall uninstall-without-shell XDG_RUNTIME_DIR="$work/no-shell" && [[ -d $plugin_dir ]] && on_bar' "without a running shell --uninstall fails and removes nothing"
# shell.json that cannot be read while the shell keeps its layout.
config_mode=$(stat -c %a "$config")
chmod 000 "$config"
uninstall uninstall-unreadable && unreadable_status=0 || unreadable_status=$?
chmod "$config_mode" "$config"
check '((unreadable_status != 0)) && [[ -d $plugin_dir ]] && grep -q "^.*Could not read $config to see whether Sotto.s glyph is on the bar: .*Permission denied. Nothing was removed." "$work/uninstall-unreadable.out"' "with shell.json unreadable, --uninstall keeps the plugin folder and says why"
sleep 1
check 'on_bar' "the glyph is still on the bar after that"
check 'uninstall uninstall && [[ ! -e $plugin_dir ]] && ! on_bar && grep -q "glyph off the bar" "$work/uninstall.out"' "--uninstall takes the glyph off the bar, then removes the plugin folder"
# A glyph left on the bar after its folder was deleted by hand.
jq '.bar.layout.center += [{"id": "sotto.dictation"}]' "$config" >"$config.tmp" && mv "$config.tmp" "$config"
in_shell omarchy-shell shell reloadConfig >/dev/null
sleep 1
check 'on_bar && [[ ! -e $plugin_dir ]]' "an orphaned glyph is on the bar with no plugin folder"
check 'uninstall uninstall-orphan && ! on_bar && grep -q "already gone" "$work/uninstall-orphan.out"' "--uninstall takes the orphaned glyph off the bar"
check 'uninstall uninstall-again && grep -q "is not installed" "$work/uninstall-again.out"' "a second --uninstall finds nothing left to remove"

# ------------------------------------------------------------- composites

say "--- composites"
cd "$evidence/raw"
crop_top() { magick "$1.png" -crop 1000x90+300+0 +repage "$evidence/curated/.$1.png"; echo "$evidence/curated/.$1.png"; }
magick $(for s in idle starting listening transcribing delivered copied failed-kept failed-plain; do crop_top "$s"; done) -append "$evidence/curated/states-tokyo-night.png"
magick $(for s in light-idle light-listening light-transcribing light-failed; do crop_top "$s"; done) -append "$evidence/curated/states-catppuccin-latte.png"
magick $(for s in notice-missing notice-cleared; do crop_top "$s"; done) -append "$evidence/curated/notices.png"
magick $(for s in stop-before stop-failed stop-failed-later cancel-failed; do crop_top "$s"; done) -append "$evidence/curated/failed-stop-keeps-pill.png"
magick $(for s in crash-before crash-listening crash-kept crash-reused older-sotto; do crop_top "$s"; done) -append "$evidence/curated/sotto-quit.png"
magick $(for s in unreadable-before unreadable unreadable-later unreadable-recovered unreadable-quit unreadable-first; do crop_top "$s"; done) -append "$evidence/curated/read-failure-keeps-pill.png"
magick $(for s in late-readable-before late-readable-lost late-readable-failed late-readable-later late-unreadable-lost late-unreadable-failed late-unreadable-later late-dismissed-failed; do crop_top "$s"; done) -append "$evidence/curated/late-stop-after-quit.png"
magick $(for s in still-listening still-transcribing; do crop_top "$s"; done) -append "$evidence/curated/without-motion.png"
magick \( drag-to-left.png snapped-left.png +append \) \( drag-to-bottom.png snapped-bottom.png +append \) \
  \( drag-to-right.png snapped-right.png +append \) \( drag-to-top.png snapped-top.png +append \) -append -resize 35% "$evidence/curated/drag-and-snap.png"
magick snapped-left.png -crop 120x420+0+290 +repage -filter point -resize 200% "$evidence/curated/upright-left.png"
for frame in start moved next; do
  magick "rule-a-$frame-1.png" "rule-a-$frame-2.png" -background black -gravity north +append "$evidence/curated/.rule-a-$frame.png"
done
magick "$evidence/curated/.rule-a-start.png" "$evidence/curated/.rule-a-moved.png" "$evidence/curated/.rule-a-next.png" -append -resize 35% "$evidence/curated/rule-a-two-displays.png"
for frame in copied-shows after-copied; do
  magick "$frame-1.png" "$frame-2.png" -background black -gravity north +append "$evidence/curated/.$frame.png"
done
magick "$evidence/curated/.copied-shows.png" "$evidence/curated/.after-copied.png" -append -resize 35% "$evidence/curated/rule-a-after-copied.png"
for frame in coalesced-named-a coalesced-named-b; do
  magick "$frame-1.png" "$frame-2.png" -background black -gravity north +append "$evidence/curated/.$frame.png"
done
magick "$evidence/curated/.coalesced-named-a.png" "$evidence/curated/.coalesced-named-b.png" -append -resize 35% "$evidence/curated/rule-a-coalesced.png"
magick \( small-upright.png -crop 300x560+0+0 +repage \) \( -size 20x560 xc:black \) \
  \( scaled-upright.png -crop 600x1080+0+0 +repage -resize 50% \) -background black -gravity north +append "$evidence/curated/upright-small-displays.png"
cp listening.png "$evidence/curated/desktop-tokyo-night.png"
magick drag-to-left.png -crop 560x440+0+290 +repage "$evidence/curated/drag-ghost-left.png"
magick \( bar-left-top.png -crop 1000x140+300+0 +repage \) \( bar-left-left.png -crop 240x420+0+290 +repage -background black -gravity west -extent 1000x420 \) -append "$evidence/curated/bar-on-the-left.png"
magick verbs-received.png -crop 800x440+0+0 +repage "$evidence/curated/verbs-received.png"
cp light-listening.png "$evidence/curated/desktop-catppuccin-latte.png"
rm -f "$evidence"/curated/.*.png
cp "$work/verbs.log" "$evidence/verbs.log"
cd - >/dev/null

say "PASS: $passes checks"
