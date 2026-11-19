#!/usr/bin/env bash
# Runs inside private-session.sh: fcitx5 (Mozc and Pinyin) on the nested compositor, the app, and typed input.
# The Slint half's tools/ime-session.sh with the GPUI build's switches.
# ime-session.sh <outdir>
set -uo pipefail
out=${HOME%/home}
here=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-$HOME/.cache/sotto-cargo-target-gpui/release/sotto-gpui}
[ "$HOME" = "$out/home" ] || { echo "run through private-session.sh" >&2; exit 1; }
export LANG=C.UTF-8 LC_ALL=C.UTF-8
mkdir -p "$HOME/.config/fcitx5"
cat > "$HOME/.config/fcitx5/profile" <<'P'
[Groups/0]
Name=Default
Default Layout=us
DefaultIM=keyboard-us

[Groups/0/Items/0]
Name=keyboard-us
Layout=

[Groups/0/Items/1]
Name=mozc
Layout=

[Groups/0/Items/2]
Name=pinyin
Layout=

[GroupOrder]
0=Default
P
fcitx5 --replace -d > "$out/fcitx5.log" 2>&1
sleep 3
SOTTO_GPUI_AUTOSTREAM=600000 SOTTO_GPUI_REDUCE_MOTION=1 SOTTO_GPUI_SIZE=1280x800 "$BIN" > "$out/app.log" 2>&1 &
APP=$!
for _ in $(seq 100); do hyprctl clients -j | grep -q "\"pid\": $APP" && break; sleep 0.1; done
"$here/win.sh" $APP size 1280x800
sleep 2
wtype -P Control_L -k a -p Control_L; wtype -k BackSpace; sleep 0.3
wtype "Japanese: "; sleep 0.3
fcitx5-remote -s mozc; sleep 0.8; echo "im=$(fcitx5-remote -n)" >> "$out/steps.log"
wtype -d 60 "nihongo"; sleep 0.8
"$here/win.sh" $APP shot "$out/ja-preedit.png"; grim "$out/ja-preedit-output.png"
wtype -k space; sleep 0.8
"$here/win.sh" $APP shot "$out/ja-candidates.png"; grim "$out/ja-candidates-output.png"
wtype -k space; sleep 0.8
grim "$out/ja-candidates-2.png"
wtype -k Return; sleep 0.6
fcitx5-remote -s keyboard-us; sleep 0.5
wtype " / Chinese: "; sleep 0.3
fcitx5-remote -s pinyin; sleep 0.8; echo "im=$(fcitx5-remote -n)" >> "$out/steps.log"
wtype -d 60 "zhongwen"; sleep 0.8
"$here/win.sh" $APP shot "$out/zh-candidates.png"; grim "$out/zh-candidates-output.png"
wtype -k space; sleep 0.8
fcitx5-remote -s keyboard-us; sleep 0.5
"$here/win.sh" $APP shot "$out/ime-done.png"; grim "$out/ime-done-output.png"
kill $APP; fcitx5-remote -e 2>/dev/null; sleep 0.5; pkill -P $$ 2>/dev/null
pid=$(pgrep -u "$(id -u)" -f "^fcitx5 --replace -d" | head -1); [ -n "$pid" ] && [ "$(tr '\0' '\n' < /proc/$pid/environ | grep '^HOME=')" = "HOME=$HOME" ] && kill $pid
