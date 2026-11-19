#!/usr/bin/env bash
# Both picture paths at the nested window's own size and at fixed 1280x800 and 2560x1600 pages, one at a time.
set -u
cd "$(dirname "$0")/../.."
for size in native 1280x800 2560x1600; do
  for path in accelerated software; do
    R="$HOME/.cache/sotto-tmp/runs/embed-$path-$size"; rm -rf "$R"; mkdir -p "$R"
    view=""; [ "$size" = native ] || view="$size"
    WP_VIEW="$view" timeout 150 node scripts/with-nested-hyprland.mjs "$R/nested" web-pane-spike/scripts/embed-inside.sh "$R" "$path" 2>&1 | grep -E "window at|tree_cpu|still running: \[.+\]" | sed "s/^/[$path $size] /"
  done
done
echo MATRIX DONE
