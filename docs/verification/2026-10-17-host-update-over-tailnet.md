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

## Limits

The panel itself is unchanged. No live provider turn, real Tailscale approval, Linux start-at-boot update or forge update was run here. Zach deferred the real Linux host check until the next Owl release and his go. These local journeys verify the socket and SSH choice against stand-ins; they do not replace that deferred check.
