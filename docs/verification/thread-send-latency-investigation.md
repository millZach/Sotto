# Thread send latency investigation

September 11, 2026. Read-only investigation prompted by Zach's slow manual sends.

The normal-profile turn log records a completed `manual-send` at
`2026-09-12T03:07:32.339Z`: total **10,829 ms**, delegation **158 ms**.
Only timing/type/outcome fields were extracted; message content and identifiers
were not copied into this report. One observation does not establish a percentile.

`delegationMs` covers the host execute call, including its guarded thread read
and dispatch. It excludes the coordinator's pre-send and confirmation snapshots,
as well as persistence. Therefore **10,671 ms was outside that execute interval**;
the log does not separate that remainder into refresh, storage, and other work.

Relevant code:

- [Manual send](../../src/main/agents/control.ts) persists its draft when needed,
  observes the target, and awaits `host.snapshot()` before validating/dispatching.
  After accepted dispatch it awaits another snapshot to confirm the exact message.
- [T3 snapshots](../../src/main/agents/t3.ts) await both the orchestration shell
  and `server.getConfig`, then all observed thread-detail reads. An in-flight
  snapshot is joined. A slow unrelated read can delay the selected thread's send.
- The T3 send adapter also performs a fresh target-thread guard immediately before
  posting. These permission/takeover protections must survive optimization.
- [Renderer commands](../../src/renderer/src/agents/AgentContext.tsx) and the
  controller each serialize most actions. The command turn timer starts after
  controller queue admission, so earlier queue delay is not included above.
- [Manual composer](../../src/renderer/src/agents/ThreadsView.tsx) does not append
  a pending message to the transcript; it waits for provider state and a matched
  delivery receipt. It must not label an unconfirmed submission as sent.

Recommendation: add per-stage timing and a deterministic delayed-snapshot test,
then introduce targeted authoritative thread reads for send validation and exact
message confirmation. Keep unrelated provider discovery/history off this path.
Show an immediate pending message, then confirmed or failed state, preserving
durable IDs, retained drafts, and duplicate-send prevention.

Removing T3 may reduce transport/provider overhead, but it does not automatically
remove Sotto's broad snapshot waits, command queues, or confirmation UX.
The measured send is evidence to prioritize this now; it is not proof of which
individual refresh endpoint consumed the remaining time. No latency fix or new
live send was performed in this investigation.
