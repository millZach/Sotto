# Each layer passes on only the threads that changed (#925)

The plan behind ADR-0016's amendment of October 24, 2026, accepted October 25. Step 1 landed in #1502, step 2 in #1515, and step 3 from `perf/thread-changes-switch`.

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
   - **Landed.** All seven adapters (Claude, Codex, Grok, Devin, Muse, OpenCode and Cursor) offer `subscribeActivityChanges` beside their activity snapshots, and all seven mark their own changes (`adapterThreadChanges.ts`), so none uses the shim. An adapter falls back to it only for a first publication, the first after a connection or another change to every thread, and one bringing more than one new thread. `publishChanges` now leaves out a record equal to the one published, unless the same change removes or places that thread, and a rest equal to the published rest, so a publication carries only what changed. The contract also checks a thread watched from before it is created, and with `SOTTO_VERIFY_THREAD_CHANGES=1` checks both forms after every publication in every case. Nothing above the adapters reads the changes yet, so the owner-scale `threadRecordsTouched` count does not fall until step 3.
3. **The wrapper and the provider switch.** `threads.ts` binds IDs and `providerSwitch.ts` names providers for upserts only, mapping removals to Sotto IDs, and each keeps its map.
   - **Landed.** The identity wrapper offers `subscribeActivityChanges` whenever its adapter does. It keeps a mirror of each form the adapter publishes, hands each upsert on under its Sotto thread ID and maps removals and placements to Sotto IDs. An adapter record it handed on before comes out as the same record. Nothing goes out before the durable bindings load, and the first publication after they do is whole.
   - The provider switch takes each provider's activity as thread changes, from the wrapper, or through the shim from a host that publishes none (the fakes and the held stand-ins). Each provider's threads are a thread map that a change applies to at a cost that follows the change. A read, or a provider that disconnects naming no threads, leaves the map apart from what the subscription published, and the next publication replaces it whole, as every publication used to. The switch names each thread once per provider record and publishes changes of its own. A new thread of one provider is placed before the next provider's first thread. A change to a provider's connection or catalog carries the rest, and threads it drops are removals.
   - The switch's activity snapshot, which the workspace still reads, is built from those maps: each thread is the record the switch named, so the snapshot costs a reference per thread rather than a new record, and says what it said before. Its records are now frozen.
   - At the owner's scale on Owl, thread records touched fall from 1,310 to 889 per streamed update, and from 5,800 to 4,299 per send. The adapter and the wrapper touch about one record an update. The switch still walks its threads once to build the workspace's snapshot, until step 4. The adapter's copy of its whole view went with its last snapshot subscriber. `ownerScaleWorkBudget.perf.test.ts` has the figures, and verifying mode checks the wrapper's and the switch's changes, and the switch's threads against the wrapper's whole snapshot, through every scenario.
   - For step 4: the workspace subscribes to the switch's changes with the same `historyFromEvents` as now, so the switch subscribes to its providers as it does. The switch's records are owned and frozen, so `accept` merges over them without copying them. A provider's read still replaces the switch's map until the next publication, and a read in the message form changes each watched thread there and back. The switch's activity snapshot can go once the workspace and the tests no longer read it.
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
