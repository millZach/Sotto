#!/usr/bin/env bash
# Builds the three parts on forge: the N-API addon that sends a descriptor, the H.264/AAC test clip, the Rust window.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
NODE_INC="$(mise where node@"$(cat "$HERE/../.node-version")")/include/node"
gcc -O2 -shared -fPIC -I"$NODE_INC" "$HERE/helper/fdpass.c" -o "$HERE/helper/fdpass.node"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc=size=640x360:rate=30 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 10 \
  -af volume=0.2 -c:v libx264 -pix_fmt yuv420p -profile:v main -c:a aac -b:a 96k -movflags +faststart "$HERE/helper/clip.mp4"
( cd "$HERE/receiver" && CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/sotto-cargo-target}" TMPDIR="${TMPDIR:-$HOME/.cache/sotto-tmp}" cargo build --release -j 4 )
