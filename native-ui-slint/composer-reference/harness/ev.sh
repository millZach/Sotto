#!/usr/bin/env bash
# ev.sh <file.cjs | -> : runs main-process JavaScript in the driven Sotto (see cref-main.cjs) and prints its JSON result.
set -euo pipefail
run=$HOME/.cache/sotto-tmp/cref-run
rm -f "$run/eval-out.json"
if [ "$1" = - ]; then cat > "$run/eval.tmp"; else cp "$1" "$run/eval.tmp"; fi
mv "$run/eval.tmp" "$run/eval.cjs"
for _ in $(seq 1200); do [ -e "$run/eval-out.json" ] && { cat "$run/eval-out.json"; echo; exit 0; }; sleep 0.05; done
echo "no answer" >&2; exit 1
