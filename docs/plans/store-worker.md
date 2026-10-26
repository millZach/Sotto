# Thread-store writes and stored-thread reads off main (#1457)

The plan behind ADR-0016's amendment of October 26, 2026, accepted the same day: the thread store's writes, and reading back a stored thread's activity, move to one store worker.

## Zach's picks, October 26, 2026

- **One store worker writes.** A worker thread with its own connection makes every write to `threads.sqlite`. Main posts it each change in order and holds what it posted until the worker says it committed, so what main reads straight after a write still sees it. Main keeps a connection that only reads. Moving only the publish's event batch, and keeping two writers, was the smaller change; it was not picked because main's other saves would then wait on the worker's write lock. Spreading the writes over ticks on main was not picked because main would still spend the same time on the disk.
- **The worker reads a stored thread back, and the provider waits for it.** Opening a stored thread reads and parses its activity on the worker. The observation reaches the provider only once the list has arrived, so new records still merge onto the stored list. Reading in slices on main, and reading only the shown window with each record's sequence stored beside it, were not picked.
- **Amendment first.** This plan and the amendment go as a documents-only draft pull request; the build follows in steps, each with its own pull request.

## The problem

Two parts of #1451 stay open, and recordings still show them (#1457):

- **A publish writes thread events on main.** `WorkspaceHost.activityPublication()` → `applyEvents()` → `writeEvents()` → `ThreadStore.appendBatches` commits inside the publish, on main's only connection (`threadStore.ts`, `DatabaseSync`). At 16:54 on October 23 (0.1.41-owl.20261023.5) the event inserts inside `publishNow` were 0.65 s of the minute. With the log's checkpoints off main (#1451), a busy disk can still hold one save for about 0.85 s, because on Windows a write waits while another thread flushes a large file on the same disk.
- **Opening a stored thread reads its whole activity on main.** `holdActivities` → `readActivities` → `activityState` held main for 0.61 s on one thread: one query for up to 2,000 rows (about 10 MB), then `JSON.parse` and the activity schema for every row.

## What main relies on today

Every write is synchronous on main, and much of main reads straight back what it just wrote:

- **The publish.** `applyEvents` writes the waiting events, then reads each watched thread's message window (`loadWindow` → `readMessages`) and each other thread's summary (`summary`, `activityCount`) from the store. Streamed appends already wait for the 250 ms write window and are laid over the stored window from memory (`withWaitingAppends`); every other event is read from the store.
- **Reads that commit first.** `messageIdentities`, `message`, `threadPrompts`, `turnsFrom`, `hasRecordedUserMessage`, `recordedUserMessages`, `addVisual`, `recordAnswer`, `eventsAfter` (a catching-up client), `watcherRead` and the handover read each call `writeEvents` and then read. `flushEvents` does the same for an adapter about to save its cursor.
- **Activity saves.** `planActivitySync` reads the message epoch from the events table, so an activity save depends on the events ahead of it being committed.
- **Failure.** A batch that does not commit stays waiting and is retried at 1 s, doubling to 30 s (ADR-0016, September 27). A failed write surfaces the history-save notice.
- **Durability** (ADR-0016, October 13 and 19, and `sqliteDurability.ts`). Sotto quitting or crashing loses no commit. Answers, additions, replacements and rewinds are committed at the publish that carries them, durable before anything can act on them. No provider cursor is saved past text the store has not committed. Every removal the user asks for commits at FULL, and its scrub runs a TRUNCATE checkpoint.
- **Stored activity** (ADR-0016, October 10, #918). A stored thread's records are read back when a window observes it, before the observation reaches its provider, and when its provider publishes a record that is new or changed for it. Anything else reads the stored list back and merges onto it, so each record keeps its sequence.

## The design

### The store worker

- **One worker, one writer.** `threadStoreWorker.ts` opens `threads.sqlite` with the same pragmas, and it is the only connection that writes. It also runs the log's checkpoints, so `walCheckpointer.ts` folds into it: with no other writer, its RESTART no longer waits for main's saves. Main's connection is opened read-only (`query_only`). The headless host builds the worker beside its index, as it does the checkpoint worker today (`scripts/build-host.mjs`).
- **Posted in order, committed in order.** Main posts every write as a message: event batches, activity syncs and releases, visuals, wake-ups, message replacements, removals and the privacy switch. The worker applies them in the order posted, in the transactions they use today (one transaction per publish with a savepoint per thread), and answers each with what committed and what failed. The event schema check and `JSON.stringify` move to the worker with the inserts.
- **Main holds what it posted.** A posted write stays in memory on main, as a waiting batch does today, until the worker says it committed. A failed one is retried as a failed batch is now.

### Reading what was just written

- **The publish lays what is posted over what is stored.** The message window and the summary read the store and lay every posted event on top, the way waiting appends are laid on today. The publish no longer waits for any write.
- **Reads that need the store wait for it.** Each read that commits first today waits until the worker has committed everything posted for that thread, then reads. That covers identities, a stored message, prompts, turns, recorded user messages, a visual being anchored, an answer, `eventsAfter`, Watcher's read and the handover. A read that cannot wait, because its caller is synchronous, is listed in step 1 and either moves to the overlay or becomes asynchronous there.
- **The cursor gate stays.** `flushEvents` resolves once the worker has committed what was waiting for that thread, so no provider cursor is saved past text the store has not committed. While the store cannot take it, the cursor is written as it was last saved, as now.

### Durability

- **What quitting keeps.** Closing the store waits for the worker to commit everything posted, then stops it, then closes main's connection last, so quitting loses no commit.
- **What a crash can lose.** The worker is a thread of the same process, so a crash takes the writes posted but not yet committed: typically the last publish window, at most what was posted since the last commit. ADR-0016's "Sotto crashing loses no commit" becomes "loses no commit the worker made". That is the October 13 trade, widened from streamed appends to every write in that window. It is bounded the same way: no cursor is saved past an uncommitted write, so the provider supplies those events again.
- **Answers and rewinds.** "Durable before anything can act on them" holds: whatever acts on an answer or a rewind waits for the worker's commit first.
- **Removals.** They commit at FULL on the worker, and their scrub runs its TRUNCATE checkpoint there. The user's removal reports done only once the worker says so.

### Opening a stored thread

- **The worker reads it.** When a window observes a stored thread, main asks the worker for its activity. The worker runs the query, parses each row and checks it against the schema, then hands the records back. Main freezes them and holds them as `holdActivities` does now. Handing back about 10 MB is still a structured-clone read on main. Step 3 measures it, and hands the list back in pieces if one piece holds main too long.
- **The provider waits for it.** The observation of that thread reaches its provider only once the list has arrived. Other threads in the same observation go at once. A record the provider publishes for a thread whose list is still on its way is held and merged once the list arrives, so it keeps its sequence.
- **What the user sees.** The pane shows the thread's messages at once and its activity a moment later, where today both came in one publish.
- **The adapters' handoff** (`storedActivities`, `hasActivities`) stays a read on main's connection in this plan. It runs once per thread per run, when something first changes its activity.

### When the worker cannot run

Where the worker file is missing, as under the test runner, or the worker goes, main opens its connection for writing and writes as it does today. Waiting writes are then committed from main, and the read-back happens on main as now. A store that falls back says so in the log by a stable event name. The behaviour is the same either way.

## Steps

One pull request per step. Each step keeps the behaviour of the one before it, and can be reverted alone.

1. **The seam.** The thread store's writes go through one writer interface, posted and acknowledged. Its first implementation commits on main at once, as now. Every read that relies on a write is moved onto the overlay or the wait above. Nothing leaves main yet.
   - **Gates:** the existing store, workspace, history-retry and stored-activity tests; the owner-scale budget, whose steps already wait for file work to finish; and a test that every read the list above names sees a write posted just before it.
2. **The worker writes.** `threadStoreWorker.ts` takes every write and the checkpoints, and main's connection reads only. The fallback is step 1's writer.
   - **Gates:** an equivalence test that runs the same seeded operations through both writers and compares the store's rows. Also crash tests (the worker gone mid-batch, a failed commit retried, quitting with writes posted), removals at FULL with their scrub, and a recording that shows no SQLite write inside `publishNow`.
3. **The worker reads stored threads back.** Opening a stored thread reads and parses on the worker; the observation waits, and provider records wait to merge.
   - **Gates:** `workspaceStoredActivity.test.ts`'s cases with the read on the worker, including a provider record arriving before the list, and the time main is held handing a 2,000-record list back.
   - **Docs:** the guide and `CONTEXT.md` say that activity can arrive a moment after a stored thread's messages.

## Risks

- **A read that skips the overlay or the wait** sees the store behind main. Step 1 lists every reader and tests each one with a write posted just before it.
- **Memory while the disk is slow.** Posted writes stay in memory until they commit, so a stuck disk grows them. They are capped as waiting batches are today: past the cap, the publish surfaces the history-save notice and new events wait in the provider, as they do when the store cannot take them.
- **Structured clone both ways.** Posting each batch, and receiving a read-back list, costs main a copy. Event batches are small. The read-back is measured in step 3.
- **The crash window.** Writes posted but not committed are lost on a crash. The cursor gate bounds what that can cost, as it does for streamed appends.

## Not in this plan

- **Usage and sub-agent stores** keep their own connections on main.
- **The adapters' handoff reads** stay on main's read connection.
- **The message window** still reads on main's read connection: it reads a window of turns, not the whole list.
