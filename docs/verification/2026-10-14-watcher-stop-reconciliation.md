# A confirmed remote Stop all during reconciliation

Checked on Windows from source `397ecd805c81de85ab7817f1d01bbfde90adda9a`,
branched from main `8bec47a23a522ce3c645a3ed7ac9531d8814b388`. This restores
Watcher's existing confirmed-stop and exact-receipt rules in ADR-0073.

The paired-host regression holds a remote stop at the socket-control boundary before the
owning host admits it, then runs the master's real reconciliation. Old main
returned `uncertain`: the exact read fenced the as-yet unrecorded operation.
With the stop held as in flight, the same ordering returns `stopped` or
`requested`, and the owning receipt confirms acceptance.

Two neighboring regressions distinguish actual uncertainty. A lost reply after
host admission reconciles its accepted receipt without another stop. An
unconfirmed transmission that never reached admission releases in-flight
ownership, settles through an exact absent receipt, and refuses a late packet
with the same fenced identity. The complete paired file passed all 40 cases,
including the existing confirmation, takeover, permission-ceiling and phone
revocation cases. The services, socket, persistence and reconciliation are real;
provider effects are scripted. No live provider, remote machine or installed
release was used.

`npm run build` passed, then the selected journeys from `watcher.spec.ts` and
`watcher-gate.spec.ts` passed five tests in 24.3 seconds. The unseeded Owl journey
starts main's Watcher on the fake Codex app server, sends the first message and
changes the in-flight limit. The gate journeys preserve ordinary sends and
saved records on stable and Owl, refuse private actions with the local host
off, and apply the changed limit to the running Watcher.

I inspected the real-main dark Watcher capture at 1280x800 content size and the
stable dark and Owl light captures at the 820x560 minimum. The message and
composer remain readable; existing header ellipses fit the minimum. The gate
journeys also check both themes at 1600x1000 and 1280x800, with reduced motion,
and assert no horizontal overflow. No UI, design baseline or permission policy
changed.

[Main's Watcher after its first message](../../artifacts/watcher-paired-hosts/stop-reconcile-main-1280.png)

The current desktop renderer has no Stop all caller. This app journey therefore proves
Watcher compatibility, not a remote Stop all UI flow. The regression proves
the affected real paired-host service boundary. Installed desktop, live-provider,
macOS, Linux and phone execution are not verified here.

The earlier #991 full-suite failure also returned `uncertain`, but did not
capture its refusal code. The forced regression establishes this reachable race;
it does not prove that earlier run's precise interleaving.

Raw native results are retained under `.zstack/perf-991-remaining/` with the
`watcher-stop-fix-` prefix: red/green, final focused/typecheck/lint, notices,
build and app logs and exit records.