#!/usr/bin/env bash
# Keep scratch writes inside the worktree: tools/worktree-test-sandbox.sh npm test -- --maxWorkers=2
set -euo pipefail
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p "$repo/.cache/tmp"
cd "$repo"
# Bubblewrap's new root belongs to this user. Binding the host root instead
# would map its owner to nobody and fail Sotto's private-runtime ancestry check.
exec bwrap \
  --ro-bind /usr /usr --ro-bind /etc /etc --ro-bind /home /home \
  --ro-bind /run /run --ro-bind /var /var --ro-bind /opt /opt \
  --symlink usr/bin /bin --symlink usr/bin /sbin \
  --symlink usr/lib /lib --symlink usr/lib /lib64 \
  --bind "$repo" "$repo" --bind "$repo/.cache/tmp" /tmp \
  --dev /dev --proc /proc --setenv TMPDIR /tmp \
  mise exec node@24.21.0 -- "$@"
