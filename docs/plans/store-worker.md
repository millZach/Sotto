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
2. **The worker writes.** `threadStoreWorker.ts` takes every write and the checkpoints, and main's connection reads only. The fallback is step 1's writer. **Landed** October 26, 2026; see "Step 2: the worker writes" below.
   - **Gates:** an equivalence test that runs the same seeded operations through both writers and compares the store's rows. Also crash tests (the worker gone mid-batch, a failed commit retried, quitting with writes posted), removals at FULL with their scrub, and a recording that shows no SQLite write inside `publishNow`.
3. **The worker reads stored threads back.** Opening a stored thread reads and parses on the worker; the observation waits, and provider records wait to merge.
   - **Gates:** `workspaceStoredActivity.test.ts`'s cases with the read on the worker, including a provider record arriving before the list, and the time main is held handing a 2,000-record list back.
   - **Docs:** the guide and `CONTEXT.md` say that activity can arrive a moment after a stored thread's messages.

### Step 1: what reads what was just written

Built on October 26, 2026. Every write the workspace makes goes through `ThreadStoreWriter` (`threadStoreWriter.ts`). The first writer, `ThreadStoreWriterOnMain`, commits inside `post` and confirms before it returns, so nothing observable changes. The tests also run the workspace over `DeferredStoreWriter` (`tests/fixtures/deferredStoreWriter.ts`), which holds every confirmation until the test releases it, as the worker will.

- **The seam.** `post(write, confirm)` takes a write as data: event batches, one thread's events, activity lists, a release, redacted identities, a visual, visuals removed, wake-ups, a forget, the sub-agent words mark, and history off or on. Each is applied in the transactions the store uses now, and `confirm` hears once what committed and what failed. Writes commit in the order posted. `posted(threadId)` lists the events posted for a thread and not yet confirmed, `unconfirmed(threadId?)` says whether anything is, and `confirmed(threadId?)` settles once it all is. `drain()` commits everything at once, for shutdown, and `close()` drains, then closes the store.
- **One batch per thread in flight.** A thread's posted batch stays at the front of its waiting events until it is confirmed, and its next batch is posted only then, so nothing commits ahead of a batch that failed. A failed batch stays there whole and is retried as now. An answer waits behind whatever its thread still holds, a batch in flight or a failed batch waiting for its retry, so it commits after the words it answered.
- **Clearing a thread.** Once its forget is posted, nothing more of the thread is posted (`admitted`): what was posted before commits ahead of the forget and is taken out with the rest. What it still holds is dropped once the forget is confirmed, and kept if the forget fails, so a failed clear keeps the thread whole, as it says.
- **The overlay.** The publish reads the store, then lays over it every event posted and not yet confirmed, then what waits behind a batch in flight (`heldEvents`, `windowWithHeld`, `applyEventsToWindow` in `storeOverlay.ts`). With nothing in flight it lays the waiting appends, as before. A thread whose batch failed lays nothing.

| Read | How it sees a write posted just before it |
| --- | --- |
| The pane's window (`loadWindow` → `readWindow`), Watcher's replies, the comparison's first read, `threadMessages` | Overlay. A window asked for in turns keeps every message the events add until it is read again. |
| The sidebar's summary (`threadSummary`) | Overlay. An alias, or a replacement that changes a role, shows once confirmed. |
| `messageIdentities` | Overlay: the whole history read while a write is in flight. Eight adapters seed from it synchronously. |
| `hasRecordedUserMessage`, `recordedUserMessages` | Overlay: the waiting and the posted events are evidence. |
| `threadMessage` (a delegation's reply, a fork's check) | Overlay, as above. |
| The handover (`threadHandover`, `watcherHandover`, the fork's handover) | Overlay: the whole history, with the wake-ups this run's record names. Its callers are synchronous. |
| `message` | Not yet: undefined while anything is held for the thread, as when a batch waits now. Its caller asks again. |
| `flushEvents`, the cursor gate | True only once nothing for the thread is held or unconfirmed, whatever the `streaming-publish-cost` answer. |
| `eventsAfter` | What has committed. It runs on every shell a socket is pushed, so it never waits. A posted event takes its sequence when it commits, after every one read, and the publish its confirmation makes carries it in the next page. |
| `threadPrompts` | Wait. Now asynchronous, with `AgentHost.threadPrompts` and the host service's prompt reader. |
| `loadEarlierMessages`'s turns (`turnsFrom`) | Wait. |
| `addVisual` | Wait for the words, then for the visual's own write before it is shown. |
| `watcherRead` | Wait. |
| `visitRecordedUserMessages` (Usage's import) | Wait. Now asynchronous, with `AgentHost` and the importer. |
| The activity save's epoch read (`planActivitySync`) | Order: the writer runs it after every write posted before it, and a flush waits for what is posted, and what waited behind it, before it saves activity. |
| Letting idle records go (`storesWhole`) | Wait: no release while an activity save is in flight; the next save asks again. |
| The start's moves (`adoptSavedActivities`, `adoptSavedMessages`) | Wait. Both are now asynchronous. |
| The privacy switch, clearing threads, a rewind's visuals | Wait. A removal is reported done once confirmed. |
| `close` | Waits for everything posted, then `dispose` drains and closes. |
| Wake-up marks in a window and the prompts' skip list | The record in memory names a posted wake-up until the store does. |
| Anchors above the window (`storesAny`) | Updated at confirmation. A message in flight is in the overlaid window. |

- **For step 2.**
  - The worker's commit is visible to main's connection before its confirmation arrives. The overlay would lay that write twice for that moment, a streamed append doubled, so step 2 must keep main's reads at the commits its confirmations have reached.
  - A summary's record count is read again when its thread's messages are, which a later confirmation does sooner; the equivalence test compares the records instead.
  - `threadMessage`, `messageIdentities` and the handover read a thread's whole history while a write for it is unconfirmed. That never happens with the store confirming on main, but step 2 makes it live, so step 2 adds an owner-scale case run with a writer that confirms later.
  - The `record` path, for a host that publishes whole histories rather than events, has no one-batch-in-flight gate, and it updates what it knows the store holds (`known`) before the confirmation. A failure heard later compares that thread afresh at its next publish.
  - Codex's `addRolloutMessage` (`codex.ts`) asks `message` and adds the message rather than aliasing it when the answer is not yet, leaning on reconcile to repair it. With a writer that confirms later that happens whenever the thread is busy.
  - Where a writer confirms later, words held behind a batch in flight when Keep local history turns off move to this run's memory store, where the writer on main had committed them and taken them out; and words held when a thread is cleared go with it unwritten. Neither reaches the file, and the log keeps no record that they happened.
- **Gates, as run.** `workspaceStoreWriter.test.ts` runs each read above over the holding writer; checks order, a failed batch retried at 1 s doubling to 30 s with the notice shown, removals committed at FULL and reported once confirmed, and closing with writes posted; checks that a thread being cleared takes nothing more into the store, an answer behind a failed batch and the cursor gate with the Owl switch off; and runs six seeded runs (mulberry32) of every operation family, clearing threads, the privacy switch and wake-ups among them, through both writers. Those compare what the publish shows while writes are held, on a good share of steps, what each thread shows once everything is confirmed, and the store's rows at the end, leaving out only what the test names a reason for. The owner-scale counts are unchanged.

### Step 2: the worker writes

Landed on October 26, 2026. The store worker (`threadStoreWorker.ts`, with main's side in `storeWorker.ts`) opens `threads.sqlite` with the store's own pragmas and is the only connection that writes it. `ThreadStoreWriterOnWorker` is now the workspace's writer: it posts every write to the worker, holds it until the worker answers, and confirms it then. Main's connection is opened with `query_only` and its own checkpoints off. The checkpoint worker of #1451 (`walCheckpointer.ts`, `walCheckpointWorker.ts`) is gone: the store worker runs the passive checkpoint and the RESTART between its writes, and with no other writer a RESTART waits only for main's reads to leave the log.

- **Built on its own.** The worker is one file with everything it imports, built beside main's bundle (`electron.vite.config.ts`) and the headless host's (`scripts/build-host.mjs`), so the thread store's code stays in the bundle that starts it. `scripts/verify-packaged-resources.mjs` looks for it in `app.asar`. The tests build it the same way (`tests/fixtures/storeWorker.ts`).
- **Applied in order, answered with what committed.** The worker applies each write with `applyWrite`, in the transactions step 1 named, so the schema check and `JSON.stringify` run there with the inserts. It answers with the threads that failed and why. Removals commit at FULL there, and their scrub's TRUNCATE checkpoint runs there.
- **Activity lists cross as changes.** A thread's list sent before goes as its identities in order and the records that are not the same frozen record as last time (`WireActivityEntry`); the worker rebuilds the list from the one it last committed, so a save of a thread holding two thousand records copies the few that changed. A worker that lacks the base fails the save, and the next sends the list whole.
- **Main's caches follow the worker.** Each confirmation of a write that is not events lets main's connection forget what it held of the threads it names (activity states and counts, visuals, wake-ups), so the next read reads the file.
- **Closing.** `close` drains: it waits, receiving the worker's answers on its port without the event loop, until everything posted is answered (up to a minute; what is left then is reported as not saved), then stops the worker, then closes main's connection last, which may write again for that so the log goes with it.
- **When the worker cannot run, or goes.** With no built file beside the store, as under the test runner, the store writes on main from the start and nothing is logged. A worker that goes logs `thread-store-worker-lost`; main's connection writes again with SQLite's own checkpoints, forgets what it held and reads the redactions again, then finishes every write the worker had not answered, in order. One the worker had begun is looked for in the file first: an event write by counting the thread's events past where they started, a visual by its identity. Any other is applied again, since applying it twice changes nothing.
- **Keep local history.** Turning it off goes to the worker, which keeps the identities, takes the file's words out waiting for the disk, closes the file and stops. Writes posted behind it wait for its answer, then commit in this run's memory store on main, which opens without a second pass over the file. Turning it back on opens the file and starts a worker again.

What step 2 had to handle, from step 1's notes:

1. **A commit main reads before its confirmation.** Each thread has one write of events unconfirmed at a time (below), and its events start after a sequence noted when it was sent (`eventFrontier`). `posted` counts the thread's events past that sequence, in the same read transaction as the window (`ThreadStore.reading`), and leaves out a write the file already holds; it reads nothing while the worker has not begun that write. Every read that lays posted events over the store does so inside one read transaction: the window, the summary, identities, one message and the handover. Tested with a real worker that has committed and whose answer main has not yet received (`threadStoreWorker.test.ts`), and over the seeded runs.
2. **Whole-history reads while a write is unconfirmed.** They no longer read the history with its words. `messageIdentities` lays the posted events over the store's identities (`applyEventsToIdentities`); `threadMessage` and `message` read the one message and lay over it what names it (`applyEventsToMessage`); the handover reads its pages and lays the posted events over each (`pageWithEvents`), unless the posted events reset or alias the thread, which moves stored messages and reads the history whole once, as before. `ownerScaleWorkBudget.perf.test.ts` gains a case over a holding writer at the owner's scale, with the open thread's history at 800 messages and at 200: identities read no stored message, one message reads one, and the handover reads the same pages at both.
3. **The `record` path.** A history-publishing host's write now holds the thread's next one, as a batch in flight does: what the host publishes meanwhile is kept and compared once the write is confirmed. An answer posted on its own holds the thread's next batch the same way. So nothing commits ahead of a write that failed, and a thread has one write of events in flight.
4. **Codex's `addRolloutMessage`.** `message` no longer answers not yet while a write is in flight: it reads the message with what is posted for its thread, and what waits behind it, laid over it. It still answers not yet behind a failed batch, a thread being cleared, or words waiting that are not posted. While a Codex thread streams, a rollout's duplicate finds its canonical message and is aliased, rather than added and shown until the next `reconcileMessages`.
5. **Words held when history turns off or a thread is cleared.** Kept as step 1 left it. Words held behind a write in flight when Keep local history turns off move to this run's memory store, and words held when a thread is cleared go with it; neither reaches the file, and no log records that they happened. That is the privacy the switch and the clear promise.

- **Gates, as run.** `tests/integration/threadStoreWorker.test.ts` (17) runs the built worker under the store: main reading only, a commit read before its answer and a write not yet committed, order under load, activity lists sent as changes, the worker gone mid-batch and between its commit and its answer, a commit that cannot get the lock failed and committed when posted again, closing with writes posted, removals with their scrub and one whose checkpoint finds a reader, Keep local history off and on, seeded writes against the writer on main, and the checkpoints. `tests/integration/workspaceStoreWorker.test.ts` (7) runs step 1's seeded runs through the workspace over the built worker against the writer on main (four seeds), quitting with writes posted, a failed commit retried with the history-save notice, and the worker gone while a thread streams. Step 1's seeded runs moved to `tests/fixtures/storeWriterEquivalence.ts`, shared by both. `tests/perf/threadStoreWorker.perf.test.ts` streams past SQLite's checkpoint threshold with main's connection read only throughout, so no SQLite write runs on main; timed against a 555 MB store (`docs/perf/2026-10-26-store-worker-writes.md`), the worst save on main fell from 36 to 125 ms to under 5 ms, and main's time in saves to about a fifth. That is a benchmark, not a recording of the app.
- **Left for later.** The worker holds each saved thread's records twice, its rebuilt list and its parsed copy, where main held one; a thread let go drops both. The read-back of stored threads is step 3.

## Risks

- **A read that skips the overlay or the wait** sees the store behind main. Step 1 lists every reader and tests each one with a write posted just before it.
- **Memory while the disk is slow.** Posted writes stay in memory until they commit, so a stuck disk grows them. They are capped as waiting batches are today: past the cap, the publish surfaces the history-save notice and new events wait in the provider, as they do when the store cannot take them.
- **Structured clone both ways.** Posting each batch, and receiving a read-back list, costs main a copy. Event batches are small. The read-back is measured in step 3.
- **The crash window.** Writes posted but not committed are lost on a crash. The cursor gate bounds what that can cost, as it does for streamed appends.

## Not in this plan

- **Usage and sub-agent stores** keep their own connections on main.
- **The adapters' handoff reads** stay on main's read connection.
- **The message window** still reads on main's read connection: it reads a window of turns, not the whole list.
