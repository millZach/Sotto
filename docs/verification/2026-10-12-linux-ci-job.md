# Linux unit CI (#870)

The changed surface is GitHub Actions. This work changes no desktop UI or production behavior, so desktop captures and Playwright journeys are not applicable. The pull request records the hosted run and each Linux shard's duration; no ruleset change or merge is part of this work.

## Workflow checks

- `mise exec aqua:rhysd/actionlint@latest -- actionlint .github/workflows/ci.yml`: clean.
- Executed the Linux result step under Bash for all 64 combinations of Changed areas result, mode and shard result. Only successful Changed areas with full/success or docs/skipped passes.
- Exercised Changed areas with documents only, renderer, preload, main, integration tests, a new area, an empty diff and a main push. Only the documents-only pull request skips shards.
- Compared the parsed workflow with base `65bcc0e6297a825d2125f8937a6aaee22c17969b`. Every existing job is unchanged except the dedicated host step's explicit SSH-required marker. The trigger, concurrency and permissions are unchanged. Draft #946's iOS timeout hunk is separate from this addition.

Six Linux shards use the same two-worker limit and file split as Windows. The Windows suite's 24–27-minute unsharded workload gives an initial four-to-five-minute test budget per shard; the hosted durations in the PR establish the actual Linux result. Linux shard 1 also typechecks.

## SSH journey

Before the change, collecting `realSshd.test.ts` with `CI=true` on Linux failed immediately because the opt-in was absent. After the change, ordinary CI collection skips the dedicated journey. Setting either `SOTTO_REAL_SSHD_REQUIRED=1` or `SOTTO_REAL_SSHD_INSTALL` without `SOTTO_REAL_SSHD=1` still fails immediately.

The enabled journey initially failed twice with a refused connection to its SSH forward. Add host attempts the host's installed Tailscale after pairing, and on forge that could move the fixture away from SSH. The fixture now puts an executable Tailscale substitute that exits unsuccessfully first on the remote PATH. It asserts `via: 'ssh'` after initial connection and reconnection. This isolates the other transport and the machine's Serve settings while keeping sshd, ssh, authentication, forwarding, pairing and the host real.

`CI=true SOTTO_REAL_SSHD=1 SOTTO_REAL_SSHD_REQUIRED=1 npx vitest run tests/integration/realSshd.test.ts --maxWorkers=2`: 1 passed in 17.22 seconds. The journey connects, answers its synthetic key and passphrase requests, pairs, checks desktop permission, sends a command, reconnects after the forward dies, leaves the host running on Disconnect, stops it on Stop host, and revokes its pairing and stops it on Forget.

## Local gates

Commands use Node 24.21.0 through mise. `npm ci`, `npm run typecheck`, `npm run lint`, `npm run notices:verify` and `npm run build` passed. The built main and preload external-dependency inventories passed `verifyExternalDependencyInventories` against the reviewed release allowlist, and the production dependency names remain exactly `node-pty`, `sherpa-onnx-node` and `zod`. The Linux release platform and tarball tests pass; their Linux support already exists on the base commit and needed no patch.

`npm test -- --maxWorkers=2` with `CI=true`: 784 files and 9,856 tests passed; 55 files and 194 tests skipped. No failures. Duration: 766.43 seconds (12m46s). Two local full-suite attempts were stopped because the temporary-file harness changed filesystem semantics: nested temporary folders inherited this repository, then a direct root bind in a user namespace made system-owned folders appear owned by an unknown UID. A Git-file boundary also gave Sotto's on-disk checkout detector a shared parent. The final command creates a safe namespace root and binds an ignored directory inside this worktree at `/tmp` using Bubblewrap, preserving ordinary temporary-path ancestry and ownership while keeping physical temporary files off forge's small tmpfs:

```sh
mkdir -p .cache/suite-tmp
bwrap --tmpfs / \
  --ro-bind /usr /usr --ro-bind /etc /etc --bind /home /home \
  --ro-bind /var /var --ro-bind /opt /opt --bind /run /run \
  --dev-bind /dev /dev --proc /proc --ro-bind /sys /sys \
  --symlink usr/bin /bin --symlink usr/bin /sbin \
  --symlink usr/lib /lib --symlink usr/lib /lib64 \
  --bind "$PWD/.cache/suite-tmp" /tmp \
  --setenv TMPDIR /tmp --setenv CI true --die-with-parent \
  mise exec node@24.21.0 -- npm test -- --maxWorkers=2
```

No test deadlines, production behavior or known flaky Watcher/checkpoint tests were changed for that local environment.

## Review

Independent Standards and Spec reviewers found no implementation findings, including after the SSH fixture isolation. Their model and effort inherited the Codex session under the run's models file. Hosted bot feedback and the final CI conclusions are recorded on the PR.
