# Watcher's sends steer by default

## Status

Accepted October 24, 2026, at Zach's word to the Watcher: "each message you send should not queue they should steer by default." Asked how far to take it, he chose to put it in Watcher's thread tool, so every Watcher does it, rather than in one Watcher's habit. He chose what the default does for a thread waiting on his card and for a provider that cannot steer. Amends [ADR-0073](0073-watcher-coordinates-threads-with-its-providers-own-tools.md), whose `send_to_thread` required a delivery. **Number provisional until merge** (docs/agents/domain.md).

## Context

`send_to_thread` took a required `delivery`: `now`, `queue` or `steer`. Watcher picked queue for anything sent to a running thread. On October 24 it queued eight messages to a busy thread fixing the composer. That thread then stopped on a question card for the user, and five of the messages piled up behind it unseen until the user found them stacked in the thread. A queued message waits for the turn to end, and a turn waiting on the user does not end.

A steer reaches the running turn at once. A Claude steer that lands while Claude thinks or writes cuts that step ([ADR-0075](0075-a-claude-steer-cuts-the-step-claude-is-thinking-or-writing.md)), and Zach wants steer anyway: what Watcher sends a working thread is meant for the work under way.

## Decision

**1. `delivery` is optional, and a send that leaves it out steers.** Main picks the mode at admission, from the thread as Sotto reads it then:

- **A running turn** is steered. With no `expectedTurnId`, the steer goes into the turn Sotto reads as running; one the send names still fences it, and a turn that has moved on refuses it, as a named steer is refused.
- **A thread whose turn is over** takes the send now and starts a new turn. Steering an idle thread does not fail. The checks a send now has still apply: a queued prompt that goes first, or one waiting for the user's review, holds it and the refusal says so.
- **A running thread whose provider cannot steer** queues the send, the only way to reach it until its turn ends.
- **A thread waiting on the user's question or permission card** takes nothing, as before: the send is refused with `PENDING_USER_REQUEST`, nothing is queued, and Watcher tells the user. Zach chose this over holding one message for after the card, or steering into the waiting turn. Only the user answers a card (ADR-0004), and a steer into a turn blocked on one could read as its answer. The refusal comes before the default is picked, so it holds for every delivery.

The result's `delivery` says which mode was used, and the operation keeps it, so receipts, outcomes, the user's own turn rule (Watcher may only steer it) and the writer's checks read it as if the send had named it.

**2. A named delivery wins.** `now`, `queue` and `steer` do what they did. A named steer to an idle thread is still refused: only the default becomes a send now.

**3. A retry matches the call as it was made.** The operation records the digest of the input without the picked delivery as well as the digest of the concrete one, as a start does for its role. A retry with the same key and no delivery reads the first receipt even if the thread has changed since, and the same key with a named delivery is another call.

**4. A paired host is sent the mode the desktop picked.** The desktop picks the delivery from its view of the host's thread and forwards a concrete `send_to_thread`, so a host from before this change, which requires `delivery`, takes it unchanged. Host protocol version 1 does not move.

**5. Watcher is told.** The tool's description, the `sotto_threads` server instructions and Watcher's system prompt say a send steers unless it names another delivery, that queue is for a prompt that must wait for the turn to end, such as the next task after this one, and that a thread waiting on the user's card takes nothing.

## Consequences

Messages Watcher sends a working thread reach it while it works, rather than waiting for a turn that may be stopped on the user. On Claude a steer can cut the step under way, which the user accepted. The composer's own default, which queues (`docs/threads-product-discussion.md`), is unchanged; this is Watcher's alone.

A send to a running Codex, Claude Code, Muse or OpenCode thread that names no delivery steers. Grok Build, Devin and Cursor do not steer, so a send to one of their running threads queues, as it did when Watcher picked queue.

`tests/integration/watcherDefaultDelivery.test.ts` covers each state on Codex and Claude Code, a Grok Build thread, which cannot steer, a named delivery and a retry. `tests/integration/watcherPairedHosts.test.ts` checks the host is sent the picked mode.
