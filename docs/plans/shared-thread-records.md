# Each layer passes on only the threads that changed (#925)

The plan behind ADR-0016's amendment of October 24, 2026, accepted October 25. Step 1 landed in #1502.

## Zach's picks, October 24, 2026

- **Option 2: publish only what changed.** Each publication carries the threads that changed and the threads that went. Every layer and subscriber keeps its own map and applies them. Option 1, keeping a record's identity through every layer, was the draft's recommendation as the narrower change; Zach chose the one whose cost follows the change whatever the threads number.
- **#925 before #1457.** The store worker #1457 needs is then fed these changes as they are.

## The problem

On every streamed chunk, five steps between an adapter and the window build a new record for every thread. They are the adapter's view and copy, the Sotto identity wrapper, the provider switch, the workspace's accept and the host stamp. Because every record arrives new, the workspace's publication then walks every thread to prove it unchanged. In the October 23 recording (0.1.38-owl.20261023.3, about 529 threads) that was about 12 s of a 44.7 s busy minute, 27% of main, and it grows with the threads rather than with what changed. The ADR amendment has the breakdown and the four options.

## The shape

- **Thread changes.** A new internal type, `AgentHostChanges`, carries:
  - a sequence number;
  - `upserts`, whole frozen thread records;
  - `removals`, Sotto thread IDs;
  - the non-thread parts (providers, catalog, projects, connection, error) only when they changed;
  - `whole: true` on a first publication, or one after a gap.
- **The subscription.** `subscribeActivityChanges(listener)` replaces `subscribeActivitySnapshots` for activity subscribers. A subscriber that sees a sequence gap calls its publisher's `resync()` and gets a whole one.
- **A map per layer.** `ThreadMap` is a shared helper holding records by ID in display order. It applies changes and builds a whole snapshot on demand for `snapshot`, `workspaceSnapshot` and ordinary `subscribe`. Each layer and subscriber owns one.
- **Frozen records.** Every record is frozen and only ever replaced, from the adapter to the window.

## How it would be built

One pull request per step. Each step keeps the old snapshot subscription working beside the new one until the last subscriber has moved, so every step can ship alone.

1. **Gates and the type.**
   - `AgentHostChanges`, `ThreadMap` and the sequence and resync rules, with unit tests: apply, remove, gap, resync, and display order after upserts.
   - `ownerScaleWorkBudget.perf.test.ts` gains "thread records touched per streamed update". The target is the threads that changed (1 or 3), and the count must not grow with the threads or the history.
   - A verifying mode rebuilds each layer's map from a whole snapshot after every change in the owner-scale fixture and compares the two. A missed removal or a stale record fails the gate.
2. **Adapters.**
   - A boundary shim turns any adapter's snapshot publication into changes by comparing each thread's record with the last one published. That is one check per thread, for that adapter's threads only.
   - Then each adapter (Claude, Codex, Grok, Devin, Muse, OpenCode) marks a thread changed on every path that changes it. Its publication sends only marked threads, and the shim goes for that adapter.
   - `tests/integration/adapterContract.ts` gains a check that every state change publishes the thread, and that a removed thread is published as removed.
3. **The wrapper and the provider switch.** `threads.ts` binds IDs and `providerSwitch.ts` names providers for upserts only, mapping removals to Sotto IDs, and each keeps its map.
4. **The workspace.**
   - `accept` applies upserts and removals to its state, merging each upserted thread with what it lays over the provider's: messages, activities, worktree, Git action, pull requests and the rest.
   - Its publication passes on what changed, including threads whose own state changed: an event, a saved activity, a settle.
   - Its saves and event batch look only at changed threads.
5. **The subscribers.**
   - The coordinator applies changes to its host state. Its shell and its finish, failure and unread tracking work per changed thread, which also covers the per-thread `acceptSnapshot` work #1334 left.
   - Usage reads upserts.
   - Watcher and delegation observe changed threads.
   - The router stamps hosts on upserts and joins every host's changes for the coordinator.
   - The host socket and the phone path apply the changes they are given.
   - When no subscriber is left on it, the old activity snapshot subscription goes.
6. **The window.** The coordinator's thread-record broadcast (ADR-0028) is fed the changed records directly.

## What it means for #1457

The workspace knows exactly which threads changed on each publish, so the #1457 store worker can be posted those upserts, removals and events as they are. A stored thread's list can be read and parsed on the worker and handed back as an upsert. #1457's design is drafted once steps 1 to 4 have landed.

## Risks

- **Drift between maps.** A missed removal leaves a ghost thread, and a missed upsert leaves a stale one. The guards are the verifying mode, the sequence numbers with resync, and the adapter contract checks.
- **The width of the change.** Every activity subscriber moves. The staged order keeps the old subscription alive until the last one has moved, so any step can be reverted alone.
- **Display order.** `ThreadMap` keeps each publisher's order, and the tests check order after upserts that move a thread.
- **Writes into frozen records.** ES modules run in strict mode, so a write into a frozen record throws. Tests find these, and each is replaced with a new record, as #1326 and #1334 did.
