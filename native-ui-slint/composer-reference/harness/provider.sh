#!/usr/bin/env bash
# The "executable" Sotto's native fixture runs for Claude: Node 24, then the repo's own fake CLI and its arguments
# unchanged. Sotto trims provider environments, so the Node path comes from the node-path file run.sh writes.
here=$(cd "$(dirname "$0")" && pwd)
exec env -u NODE_OPTIONS "$(cat "$here/node-path")" "$@"
