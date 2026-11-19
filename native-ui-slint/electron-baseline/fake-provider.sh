#!/usr/bin/env bash
# The "executable" Sotto's native fixture runs for Claude: Node 24 with stream-addon.mjs preloaded, then the repo's own
# fake CLI and its arguments unchanged. Sotto gives provider processes a trimmed environment, so the Node path comes from
# the node-path file run.sh writes. NODE_OPTIONS (which carries the Electron main hook) is not passed on.
here=$(cd "$(dirname "$0")" && pwd)
exec env -u NODE_OPTIONS "$(cat "$here/runs/node-path")" --import "file://$here/stream-addon.mjs" "$@"
