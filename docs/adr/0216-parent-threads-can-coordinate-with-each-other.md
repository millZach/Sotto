# Parent threads can coordinate with each other

## Status

Proposed and design-aligned by Zach on November 22, 2026 (question card picks on [docs/plans/2026-11-22-parent-thread-coordination.md](../plans/2026-11-22-parent-thread-coordination.md)). **Number provisional until merge** (`0216` is free on `origin/main` at `3b1ef948a9`, where `0215` is the Rust local desktop engine; recheck before merging per `docs/agents/domain.md`). It is an Owl feature (`parent-thread-coordination`, `sentToStable: false` in `src/shared/owlFeatures.ts`, per [ADR-0072](0072-sotto-owl-is-a-windows-preview-release-track.md)). It amends [ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md) so peer-coordination messages delivered into a watched thread are Sotto-owned rather than user takeover, and keeps [ADR-0002](0002-sotto-owned-thread-identity.md) and [ADR-0004](0004-authority-in-policy-records.md) whole.

## Context

Sotto already has two vertical coordination paths: Watcher (`sotto_threads` / `sotto_watcher`, ADR-0073) supervises threads from one central desk, and delegation (`sotto_delegate`, ADR-0081) lets a thread spawn hidden child threads two levels deep. Neither lets two independent top-level (**parent**) threads talk directly to each other—for example, a backend thread and a frontend thread, or two feature branches on different providers, exchanging contracts, status, or handoffs without routing everything through the user or spawning duplicate child sessions.

T3 Code's Orchestration V2 (`pingdotgg/t3code`) addresses this by exposing bounded `t3_thread_list`, `t3_thread_read`, `t3_thread_send`, and `t3_thread_wait` tools over its app-owned loopback MCP server, enforcing a strict no-privilege-escalation ceiling (`target <= caller`) rechecked under lock at dispatch. Sotto adapts that direct thread-to-thread model to its own identity, privacy, and authority boundaries.

## Decision

**1. A dedicated scoped MCP server, `sotto_coordinate`, for eligible parent threads.** It runs on `ThreadToolServer` (`127.0.0.1` loopback, one per-thread 32-byte bearer token, no browser origin) and plugs into `ScopedThreadTools` on both the desktop engine (`createDesktopEngine.ts`) and headless hosts (`src/host/index.ts`), so every provider that takes Sotto's tools gets it automatically. It stays separate from Watcher's `sotto_threads`, parent-child `sotto_delegate`, and `sotto_watcher`.

Eligible parent threads are open top-level project threads (`kind === 'project'`, `delegatedBy === undefined`, not an owlet, not a Council judge, not archived, not unsent, and on a provider that takes Sotto's tools). Watcher, Watcher history, owlets (ADR-0213), Council judges (ADR-0177), delegated child threads, host-setup/provider-job threads, and unsent threads are never offered `sotto_coordinate` and can never be listed, read, or messaged through it.

**2. Four focused tools in Slice 1.**
- `list_threads` (read-only): lists eligible parent threads newest first, scoped to the caller's own project by default with optional `project: 'all'` or an explicit `projectId`, optional title/branch `query`, `status` filter, `includeSettled`, and cursor pagination. Always omits the caller itself.
- `read_thread` (read-only): reads a bounded window of one eligible parent thread's metadata (title, project, branch, status, `waitingOnUser`, open pull requests, runtime mode) and recent messages with incremental `beforePosition` / `afterPosition` cursors and a `24 KiB` text cap. Every message is tagged with its actor provenance (`user`, `assistant`, `peer-thread`, `watcher`, `system`) and carries Sotto's untrusted-content notice.
- `send_to_thread` (mutating, idempotent on `retry_key`): sends a plain-text message (up to `16 KiB`) to another eligible parent thread, with `delivery` defaulting to `'queue'` (starts immediately if idle, queues behind a running turn; `'steer'` steers mid-turn only when explicitly requested and supported by the target's provider, otherwise falls back to `'queue'`), `expect_reply` (default `true`), and optional `wait_seconds` (`0` to `300`, default `0`).
- `read_exchange` (read-only): reads one exchange by `exchangeId` (outcome, `waitingOnUser`, and target reply labelled as the target thread's own words, capped at `32 KiB`), or lists the caller's recent exchanges and remaining budgets.

**3. Authority stays in policy records (ADR-0004).**
- No peer tool answers a question card, approves a permission, writes a policy record, widens a thread's permission mode, runs a slash command (`/compact`, `/logout`, etc.), or stops, settles, renames, or launches another thread.
- **Strict permission ceiling:** A send is refused (`PERMISSION_TOO_WIDE` / `PERMISSION_NOT_COMPARABLE`) if the target thread's `runtimeMode` is broader than or not comparable with the caller's `runtimeMode` under `RUNTIME_MODE_ORDER`. This check runs at admission and again atomically in the coordinator's private dispatch guard right before the native writer runs.
- Every incoming peer message is framed in Sotto's voice naming the sender thread ID, title, and provider, explicitly stating that it is another thread's words rather than the user's and approves nothing.

**4. Anti-loop budgets and direct-user-work fencing.**
- **Causal chain hop limit (`COORDINATION_HOP_MAX = 6`):** A send rooted in a direct user message begins a chain at `hopCount = 1`. A send triggered by an incoming peer message inherits that chain and increments `hopCount`. Once `hopCount` exceeds `6`, Sotto refuses with `LOOP_LIMIT` until the user sends a fresh direct message in either thread (which starts a new chain at hop `1`).
- **Per-target turn budget (`4`):** At most four sends from thread A to thread B per turn root of A.
- **Sliding rate limit (`6` in `10` minutes):** At most six sends total from one thread across all peers in ten minutes.
- **Direct-user-work guards:** A send is refused when the target has a pending user request card (`PENDING_USER_REQUEST`), a paused/failed/uncertain queue (`QUEUE_HELD`), or an active user composer draft (`USER_TYPING`). A queued peer send carries `expectedLastUserMessageId`; if the user sends a newer direct message into the target before dispatch, the send is fenced (`TARGET_CHANGED`) and never lands on top of the user's instruction.
- **Watcher non-takeover (amends ADR-0073):** `ThreadCoordinationService` exposes `ownsMessage(messageId)` to `AgentControl.delegationMessage`, so a peer message delivered into a watched thread does not trigger a user takeover of that thread's standing watch.

**5. Reply delivery, privacy, and restart rules.**
- When `expect_reply` is `true` and the caller is not waiting inside `send_to_thread`, Sotto observes the target turn via `watcherTurnOutcome` (never scanning all threads or cloning snapshots) and delivers a `source: 'coordination'` wake-up back to the sender through `FollowupStore`.
- `thread-coordination.json` and `followups.json` store **identities and control metadata only**—never message bodies, replies, or bearer tokens. Reply text is read from the target thread at dispatch time and respects `historyEnabled`.
- Across a restart, unresolved in-flight exchanges become `unknown` (`unknownBecause: 'restarted'`) and are never replayed (ADR-0058).

**6. Owl-only gating and phased slices.**
- Controlled by `parent-thread-coordination` (`sentToStable: false`) in `src/shared/owlFeatures.ts`, read once at startup in the desktop engine and headless host. When off, `sotto_coordinate` is not constructed or offered, no peer wake-ups are dispatched, and any saved `thread-coordination.json` stays dormant and intact.
- **Slice 1 (merged in #2835):** Local `ThreadCoordinationService`, `sotto_coordinate` MCP server, ADR-0004 guardrails, and fake-provider integration tests on desktop and headless host.
- **Slice 2 (merged in #2838; Zach's picks on November 23, 2026, from `docs/prototypes/parent-thread-coordination-prototype.html`):** Quiet left-aligned attributed card (Option A) for incoming peer messages in target threads with explicit ADR-0004 note and Open thread link, quiet exchange row under the turn (Option 1) in sender threads with status, hop count, and on-demand expandable reply (hiding raw coordination reply wake-ups from the bubble stream), plus a **Peer coordination** section in `Tools › Agents` (with **Open thread** and **Open beside**) and a quiet header indicator shown only while a peer exchange is active or queued.
- **Slice 3 (cross-machine coordination):** Optional desktop-only host-v1 features `thread-coordination-views` (`coordination-views`, `coordination-reply`, `coordination-changed`) and `thread-coordination-relay` (`coordination-remote-ask`, `coordination-remote-news`, `coordination-relay-ask`, `coordination-relay-answer`, `coordination-relay-news`), advertised only by Owl hosts with `parent-thread-coordination` on to recorded desktops and accepted only by Owl desktops with `parent-thread-coordination` on (never offered to phones/iOS or stable builds). Parent threads pass optional `hostId` (`"local"`, `"all"`, or a connected host UUID) or a host-qualified `threadId` to `list_threads`, `read_thread`, and `send_to_thread`; the desktop relay verifies paired-host callers from authenticated socket connections and snapshots, routes desktop ↔ host and host ↔ host exchanges, and forwards outcome news and on-demand replies while target hosts enforce every ADR-0004 guard locally (including clamping callers without a `remote-answer` grant to `approval-required`, enforcing the 6-hop cap across machine boundaries, and refusing cleanly with `HOST_UNAVAILABLE` when a paired host is unreachable or has coordination off). Paired-host threads render the same incoming peer cards, outgoing exchange rows, header badge, and `Tools › Agents › Peer coordination` section with host-qualified peer links and machine labels.

## Consequences

- Independent parent threads across any combination of supported providers (e.g., Claude Code ↔ Codex ↔ Antigravity) can inspect and coordinate with each other without shell workarounds or routing everything through Watcher.
- No low-permission thread can launder execution through a higher-permission sibling, and runaway ping-pong exchanges halt automatically at six hops.
- Zero Electron imports are added; the service runs cleanly inside both the out-of-process desktop engine (ADR-0210) and headless hosts.
- Stable builds show and run nothing of this until Zach flips `sentToStable: true`.
