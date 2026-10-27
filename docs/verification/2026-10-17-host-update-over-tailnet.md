# Host updates over the tailnet, October 17, 2026

The desktop half of [ADR-0088](../adr/0088-sotto-leans-on-tailscale.md) keeps the existing update panel and carries Update over the connected host's socket. Only Update changes. A host that does not offer the route, or a step the host refused or never received, keeps the SSH path. A download whose socket answer times out closes that connection to end its download before falling back to SSH. An install that has begun finishes under the host's lock; a restart that may have gone is never sent again over SSH.

## Recovery checks

The Windows recovery started from `0f5328b43` in `.worktrees/feat-host-update-over-tailnet`. No real remote host was updated.

- Before the fixes, four regression assertions failed in `hostSelfUpdateRoute.test.ts` and `socketHostUpdateClient.test.ts`: a fetch timeout chose a lost connection instead of SSH, a cancel blocked by 32 pending requests left the host downloading, a timed-out download kept its socket open, and two identical rollback outcomes lost their distinct attempt identities when parsed.
- After the fixes, the route and in-process socket suites passed all 40 tests. Adding the host self-update unit suite passed all 60 tests. The socket tests check the real server's download owner was aborted, rather than only checking that the desktop returned.
- The original `desktopHostSelfUpdate.test.ts` rollback journey failed in isolation: after the lost restart answer, a quick reconnect reached the old host while it was still stopping, and the outcome read lost its connection too. The desktop stopped waiting despite having restart budget left. This is separate from the repeated identical rollback finding: this first attempt had no earlier outcome.
- Recovery now reconnects and asks for the outcome again within that budget. The original rollback journey passed, then all ten desktop host-update journeys passed together. They exercise a built headless host in a release layout, a loopback stand-in for Tailscale Serve, the real launch script, and counted SSH connections. They include success, rollback, lost restart answer, tailnet-only retry, download fallback, cancellation, desktop archive copy and refused or unavailable socket routes.
- Both real-host suites now share the release layout and SSH recording shims through `installSelfUpdatingHost`. Their cleanup deadlines and process cleanup are unchanged. The earlier isolated cleanup-hook timeout was not reproduced, and this extraction is not a claim that it fixed that timeout.

The rollback test also scripts a lost outcome reply after the lost restart answer, so process speed cannot hide this failure. Both integration suites passed their post-extraction run: 15 tests in 94.35 seconds, including that stronger regression. Fresh full gates, performance comparisons and review are pending integration with current main.

## Restart budget review fix

Independent Standards review found that an outcome read could begin after the restart budget ended, or wait its usual 30 seconds despite having less restart time left. At `9bcbe4884`, controlled-time tests reproduced five failures: an expired budget still sent a read, a queued read waited past the deadline, a silent answer retained its pending call, queue time was not deducted, and a retry pause overran the budget. Two neighboring checks already passed.

The queue now rejects an expired read without ending the earlier update. When a read starts, its answer timer uses the remaining restart budget; the usual outcome deadline remains an upper bound. Retry pauses use only the time left. Ten controlled-time tests cover these paths, reconnecting one millisecond before expiry, preserving an earlier update failure, and a confirmed rollback just before the deadline. They use the real recovery queue and socket request timer with a held transport, without real sockets or processes.

The controlled-time file and the neighboring route and host self-update unit suites passed: 61 tests across three files in 3.80 seconds. Targeted ESLint and `git diff --check` passed. Independent Standards recheck cleared the deadline correction at `1419497ef`.

## Current desktop proof

On exact clean `1419497ef6b3482394e3bd90ae7df4dae8ea6878`, all four typechecks, lint and 189 licence notices passed. The desktop host self-update, host self-update and socket update-client integration files passed all 24 tests, including rollback after losing both the restart answer and the first outcome connection. The shared heavy-job helper held its slot through all owned descendants; no other project's processes were stopped.

A fresh build of that same candidate then passed all four existing `host-update.spec.ts` and `update-all.spec.ts` desktop journeys with one worker and no retries. They cover failed checksum, preserved conflicting version, successful retry, client/host update ordering, and a press made while the remote check is still pending. The panel checks cover 1600×1000, 1280×800 and 820×560, light and dark, keyboard focus and Escape, reduced motion, overflow and text contrast. These local fixtures stand in for the remote machine; this did not update the real forge host.

The coordinator opened the new minimum-size [checksum failure](../../artifacts/host-update/oct17-panel-failed-820x560-light.png), [preserved version conflict](../../artifacts/host-update/oct17-panel-version-conflict-820x560-dark.png) and [successful update](../../artifacts/host-update/oct17-panel-done-1280x800-dark.png) captures. The error explanations and retry controls fit; the success state names the installed version. These images come from the current build, not the earlier source thread.

Functional durations are not comparable performance evidence: background CPU was above the quiet measurement threshold. Full-suite validation, comparative timing and process resources, prerequisite integration and final PR gates remain open.

## October 26: finishing review

The branch was merged with `main` twice (`e3582b026`, then `14db20a98`). Main's timeout error for #1311 is now the timeout stage of this branch's unanswered-request error, and the branch's errors carry main's catalog words (ADR-0123). Two-axis review by Sol at max reasoning ran twice and found eight problems, each fixed with a regression test that fails on the code before its fix:

- A reconnect that reached the stopping host and dropped again lost the tailnet-only window, so SSH could sign in while the restart's budget still ran. The restart window now lasts until the outcome has been read.
- The first reconnect after a restart waited without a bound, including when the old host never dropped and the socket wait took the whole budget. It now ends at the restart's own deadline.
- After a download fell back to SSH while the tailnet reconnected, the install was refused as "not connected", including between reconnect attempts, and the restart after it was refused as well. Those steps now go over an admin connection, and the restart does so only when an earlier step of the same update went over SSH.
- After a lost restart answer, a quick reconnect could read "none" or the earlier record from the old host and stop asking. It now asks until the host says how this restart ended (`restartSettled`) or the budget ends.
- A cancel could overtake its own download on the host, come back with nothing cancelled, and leave that download running. An unconfirmed cancel now closes that request's connection, as an undelivered one already did.

Typecheck, lint, the catalog check and 242 tests in the host-update, socket, Watcher paired-host and real-host self-update files passed on Windows. Running both real-host suites alongside two other heavy files once gave a `port-taken` start of the old host, from the launch script's health check under load; the suite passed alone and both suites passed together. The full suite and the desktop journeys run in CI.

## Limits

The panel itself is unchanged. No live provider turn, real Tailscale approval, Linux start-at-boot update or forge update was run here. Zach deferred the real Linux host check until the next Owl release and his go. These local journeys verify the socket and SSH choice against stand-ins; they do not replace that deferred check.
