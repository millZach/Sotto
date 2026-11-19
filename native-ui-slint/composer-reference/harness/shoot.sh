#!/usr/bin/env bash
# shoot.sh <name> <roots-json> [boxOf-json]: captures and dumps one state into the composer-reference folder.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(cd "$here/.." && pwd)
boxof=${3:-'["form.thread-prompt"]'}
{ echo "const P = { name: '$1', out: '$out', harness: '$here', roots: $2, boxOf: $boxof };"; cat "$here/shoot.cjs"; } | "$here/ev.sh" -
