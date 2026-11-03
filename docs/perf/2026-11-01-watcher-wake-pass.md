# Watcher's wake-up pass reads only the watched threads that changed - November 1, 2026

The last item of #1248, on Owl (Watcher is an Owl feature). Counted with the owner-scale work budget, in the default
suite, and timed with a new benchmark and the round's data-transfer benchmark:

```sh
NODE_OPTIONS=--max-old-space-size=3072 SOTTO_PERF_BENCH=1 npx vitest run tests/perf/ownerScaleWorkBudget.perf.test.ts --maxWorkers=1 --disable-console-intercept
NODE_OPTIONS=--max-old-space-size=3072 SOTTO_PERF_BENCH=1 npx vitest run tests/perf/watcherWakePassWatches.perf.test.ts --maxWorkers=1 --disable-console-intercept
NODE_OPTIONS=--max-old-space-size=3072 SOTTO_PERF_BENCH=1 SOTTO_AUDIT_PROFILE='1 streaming' npx vitest run tests/perf/dataTransfer.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

The first prints every count at each shape of the owner's world (`SOTTO_WORK_SITES=1` names where each was made). The
second times one pass while a watched thread streams beside 0, 5 and 20 idle watched threads, each as long as forge's
longest (2,000 activity records, 550 messages), with owned records read through Watcher's look-ups as on the desktop.
The third writes a CPU profile of one thread streaming at the owner's scale to the temporary folder. "Before" is each
run with `src/main/agents/watcher.ts`, `watcherHosts.ts` and `watcherWakeUp.ts` as they are on `origin/main` at
`b36206904`, the two sides taking turns on forge.

## What it cost

Watcher's wake-up pass runs on every update that moves something it reacts to, and every 250 ms while threads stream.
Each pass read every watched thread whether it had changed or not, since the clock and the queue move without the
threads: two look-ups for each in the edge check, two more to observe it, one to ask whether the list still holds it,
and one to find the threads it delegated to. For each it then made its progress fingerprint again, seven
serializations, one of them the thread's whole message list, and built its observation and progress keys again.
The fixture's standing watches are part of the owner's history, so with all of it (five watches) a streamed update cost
34 look-ups and 63 serializations, against 10 and 28 with a quarter (one watch). On forge the round's profile put this at
about 6 ms of every second of main while one thread streamed.

## The change

- `WatcherHosts` keeps a journal beside the one of threads gained and lost: which threads a look-up may now find
  otherwise than at the last pass (`touchedSince`). It follows the coordinator's changes, which name the threads they
  replaced, and compares a snapshot nobody described, or a paired host's push, thread by thread once, in the walk it
  already made for threads gained and lost. A thread that moved in the list, or a change to which providers are
  connected, makes every look-up suspect.
- A pass keeps what it looked up from the pass before and looks up only the threads the journal names, a changed thread
  in its kept place. It keeps the threads under the watched threads while no thread's delegator changed, and answers
  whether the list holds a thread from what it looked up.
- A thread's progress fingerprint is kept with the owned records it was made from (`isImmutableRecord`, frozen all the
  way down and only ever replaced), and each part's JSON with its record, so a thread an update left alone is not
  serialized again, and one that streams serializes the message that grew. A record that is not owned is read every time,
  as before. The digest is the same, byte for byte.
- Observation keys are the target keys already built, and the pass hands each target's key to `progress`.

Every watched thread is still observed on every pass, with the record a look-up finds, so every wake-up is made as it
was and at the same moment.

## Before and after

On Owl at the owner's scale, the work budget's counts. They are the same on every run.

| Per update or action | Look-ups before | after | Serializations before | after |
| --- | ---: | ---: | ---: | ---: |
| One thread streaming, per update | 34 | 2.92 | 63.15 | 19 |
| Three threads streaming, per update | 34 | 4.62 | 71.31 | 28.69 |
| Saving an answer draft | 68 | 8 | 140 | 50 |
| Typing, per debounced save | 68 | 4 | 114 | 24 |
| Opening a thread | 68 | 4 | 121 | 31 |
| Sending | 136 | 10 | 793 | 613 |
| One of Watcher's tool calls | 87 | 6 | 433 | 11 |

Along the history (a quarter of it to all of it), look-ups per streamed update went from 10 to 34 before and are 2.92 at
both ends now; serializations from 27.92 to 63.15 before, and from 19.77 to 19 now. Nothing else the budget counts moved,
on Owl or on stable.

Timed with `watcherWakePassWatches.perf.test.ts`, three runs of each side taking turns, each the median of seven rounds
of 40 passes, in milliseconds a pass:

| Idle long watched threads | After an update to an unwatched thread, before | after | After a streamed chunk, before | after |
| --- | ---: | ---: | ---: | ---: |
| 0 | 0.070-0.085 | 0.021-0.022 | 0.38-0.43 | 0.41 |
| 5 | 0.36-0.38 | 0.13 | 0.57-0.72 | 0.44-0.47 |
| 20 | 0.93-1.01 | 0.28-0.31 | 1.25-1.35 | 0.64-0.67 |

Each idle watched thread cost a pass about 43 microseconds and costs about 14 now: it is still observed on every pass,
with the record it already had, so the quiet deadline, its evidence and its news are worked out as before. What a
streamed chunk costs beyond that is the streaming thread's own fingerprint, a hash over its whole history, which is the
digest a paired host reports and is unchanged.

The data-transfer benchmark's stream shows no difference: in its CPU profile the wake-up's `observeSoon`, with
everything it calls, took 15.6-16.9 ms of the 4 seconds streamed before (five runs) and 14.5-18.3 ms after (eight). Its
idle watched threads are short, so their fingerprints and keys were already cheap there. Its pass's time is the
streaming thread's fingerprint over 2,000 activity records and the pass's index of the record's workers, neither of
which this changes.

## The guards

- `tests/perf/ownerScaleWorkBudget.perf.test.ts`: both of the pass's `KNOWN_HISTORY_GROWTH` entries are gone, and its
  look-up and serialization budgets drop to the new counts with the usual tenth. One narrower entry is left: look-ups in
  the answer-draft save grow from 4 to 8. That save's count holds the working copies of two streamed threads read again
  1.5 seconds after their turns ended (`WORKTREE_REFRESH_DELAY_MS`), past the fixture's one-second settle; with all of the
  history those threads are watched, and a pass reads each watched thread that changed, once. It is held at 2 exactly.
- `tests/unit/main/watcherKeptLookups.test.ts`: a pass while one watched thread streams looks up as many threads with
  fifty idle watched threads as with none, and finds what a pass reading every thread finds (the same news, observations
  and progress) after a change in place, a change nobody described, a thread that moved and providers listed again. It
  fails without the journal, and when the journal misses a change.
- `tests/unit/main/watcherProgressFingerprint.test.ts`: an owned thread's fingerprint is the digest it always was, is not
  worked out again while its record stands, and serializes only the message that grew while a reply streams.
- In verifying mode (`SOTTO_VERIFY_THREAD_CHANGES=1`), every pass that follows the last checks each look-up it kept
  against a fresh one. The work budget's verifying run fails at the send on `origin/main` as well, on another layer's
  thread map, so it was not run to its end here.
