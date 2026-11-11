# The transfer benchmark at a running host's size (November 10, 2026)

The audit of November 10 found that the data-transfer benchmark could not show the two largest costs of a paired host
(`docs/perf/2026-11-10-performance-and-data-audit.md`, finding 3, #2390). Its fixture was far smaller than forge's host,
its desktop never asked for Watcher's projection, and its phone sent 8 of the iPhone's 20 features. A fix to either cost
would have shown no gain on it. This note records what the benchmark's host holds now, the baseline it gives, and the guard
in the default suite that holds the baseline. Nothing in the app changed. The fixes it measures are #2391, #2392 and #2393.

## What the host holds

The owner-scale fixture keeps its default scale, which every budget built on it expects. The socket benchmark builds it
with a new option, `host` (`tests/fixtures/ownerScalePipeline.ts`), which adds what forge's host held besides its threads.

| | Before | Now, with `host` | forge's host |
|---|---:|---:|---:|
| A paired desktop's Watcher work in the host's record | none | 925 requests, 929 operations | 925 requests, 929 operations |
| Requests that name the desktop that made them (`remoteOrigin`) | none | all 925 | all 925 |
| The host's threads that took part | none | 130 | 130 |
| Skill lists kept (`skillCatalogs`) | none | 6 threads, 112.8 KB | 115.2 KB |
| Accepted deliveries (`deliveries`) | none | 128, 44.4 KB | 128, 45.9 KB |
| `deliveredDrafts` and `obsoleteDrafts` | none | 128 each, 12.9 KB each | 128 each, 12.9 KB each |
| `followupReceipts` | none | 79, 8.0 KB | 8.0 KB |

The ledgers are written to `agents.json` and `followups.json` before the coordinator starts, as a host restarting finds
them. The skill lists are read through the coordinator's own `refresh-thread-skills`, as a client asks for them. The
desktop's Watcher work is in the host's Watcher record, built by the builder `watcherStatePush.perf.test.ts` already used,
now `pairedDesktopWatcherWork` in `tests/fixtures/ownerScale.ts`. Its operations carry the fields Watcher gives a start or a
send (receipt, card, draft, message, command and, for a start, its creation receipts).

## What the peers ask for

- **The desktop** used to send a hand-written list of 16 features. The listener did not know it as a desktop, so it offered
  it none of Watcher's features, and it never read Watcher's projection. Now the benchmark connects Sotto's own client of a
  paired host (`SocketHostService`, with an Owl desktop's switches) and the desktop sends what that client's hello sent:
  11 features, `watcher-reads` among them, once filtered by what this host offers. The listener records it as a desktop, as
  forge's records the laptop, and it reads its Watcher's projection with no call, which registers it for `watcher-state`
  pushes (`docs/host-protocol.md`, "Watcher on a paired host").
- **The phone** used to send 8 features. Now it sends the iPhone's 20, read from the Swift source by
  `tests/fixtures/iphoneAccepts.mjs`. `scripts/perf-bench/phone-wire-probe.mjs` reads them through the same helper now.
- **While a thread streams**, its token usage moves every tenth chunk, twice a second, as Claude's adapter reports it. A
  phone reads no reply text in a thread list push, so without it a phone was sent a list only when something else changed.

## How the clock waits

The benchmark runs main on Vitest's fake clock and steps it 5 ms at a time (`tests/fixtures/stepClock.ts`). Since review,
each step also waits until both ends of every host socket have read what the other wrote, a push still being compressed
on Node's thread pool included (`hostSocketScale`). A desktop's push over 64 KiB is compressed there, so before this, a
busy machine let the fake clock run ahead of it: the host found the desktop behind and held pushes back, and fewer were
counted. Now the host never finds a peer behind because the machine was slow, every push it makes goes, and the counts
are the same on any machine: one thread list push and one `watcher-state` per chunk to the desktop, where it counted 23
in 60 chunks before. A real link that reads slowly still has the host hold pushes back; this benchmark no longer measures
that. The host also runs 6 s before any client connects, past the 5 s after which it reconnects a provider that is
turned on, so that provider's models are in the catalog from the first hello.

## Before and after

One thread streaming, 60 chunks in 3 seconds and one more second, on Owl, long threads. Before is the benchmark as of
`c9a0940fd`, the audit's branch. Bytes are JSON. Compressed is deflate level 6, as the host compresses for a desktop; the
host compresses nothing for a phone. forge's figures are the audit's (`docs/perf/data/2026-11-10-audit/`).

| | Before | Now | forge's host | Now against forge |
|---|---:|---:|---:|---:|
| A thread list push to the desktop | 8,888 (59 pushes after one of 205,905 listing every thread) | 200,099 (60 pushes) | 210,659 (103 in 2 minutes) | 0.95 |
| The same, compressed | not counted apart | 48,317 | 60,270 | 0.80 |
| A thread list push to the phone | 6,827 (after one of 204,308 listing every thread) | 199,134 (6 pushes) | 209,015 (32 in a minute, a working thread open) | 0.95 |
| A `watcher-state` push to the desktop | none sent | 1,986,294 (60 pushes) | 1,976,203 (254 in 2 minutes) | 1.01 |
| The same, compressed | none sent | 298,236 | 365,739 | 0.82 |
| `watcher-state` built from forge's saved record (`watcherStatePush`) | | | 2,086,237, 374,132 compressed | 0.95 |
| Hello to the desktop | 416,811 | 610,613 | not measured | |
| Hello to the phone | 406,374 | 476,592 | 236,631 (154 settled threads held back) | |
| Observing the streaming threads, phone | 854,572 | 87,235 (the step window) | 92,599 for one thread | |

Each push is within a quarter of forge's. What is in one, by the top-level part of the frame, a thread list push's
`state` and its `host` counted field by field (`state.host.projects` in the evidence) and Watcher's `projection` the same
way:

| Part of a push | Now, to the desktop | forge, to the phone |
|---|---:|---:|
| `skillCatalogs` | 112,819 | 115,223 |
| `deliveries` | 44,417 | 45,933 |
| `deliveredDrafts` | 12,929 | 12,929 |
| `obsoleteDrafts` | 12,929 | 12,929 |
| `followupReceipts` | 7,980 | 7,980 |
| `host.projects` | 2,764 | 3,346 |
| `host.providers` | 2,263 | 2,760 |
| Changed thread records (`threads`) | 2,199 (1,214 to the phone) | 2,509 (about 4,200 to the laptop) |
| Parts as the push before had them | 44 of 45, 197,225 bytes, the frame's `v` and `event` among them | about 205 KB of 209 KB |

| Part of a `watcher-state` push | Now | forge |
|---|---:|---:|
| `requests` | 1,177,671 | 995,250 |
| `operations` | 783,097 | 952,735 |
| `progress` | 24,961 (130 threads) | 24,961 (130 threads) |
| Parts as the push before had them | 8 of 11 with the frame's `v` and `event`; only `progress`, `revision` and `observedAt` moved | the same |

All 60 `watcher-state` pushes changed only Watcher's progress. The user's prompt on a thread the desktop's Watcher had
worked on, which the host records against that thread and which changes the projection's requests, now reaches the
desktop in the second the benchmark waits before it counts. Before review, with the clock running ahead, it arrived late
and one of the 23 counted carried it.

## The guard

`tests/perf/hostPushSizeBudget.perf.test.ts` runs in the default suite, in about 4 seconds on forge. It builds the same
host, starts one thread, streams 10 chunks so what goes once after observing is behind it, then counts 40 more:

| Measure | Today | Budget | Lowered by |
|---|---:|---:|---|
| Bytes per thread list push to a desktop | 199,919 | 204,000 | #2393 |
| Bytes per thread list push to an iPhone | 198,970 | 203,000 | #2392, #2393 |
| Parts of a push to a desktop as the push before had them | 44 | 44 | #2393 |
| Parts of a push to an iPhone as the push before had them | 45 | 45 | #2392, #2393 |
| Bytes the desktop is sent per change of Watcher's progress alone | 1,986,099 | 2,006,000 | #2391 |
| Parts of it as the push before had them | 8 | 8 | #2391 |
| Whole `watcher-state` pushes per change of progress alone | 1 | 1 | #2391 |

A part is a top-level field of the frame, with a thread list push's `state` and its `host`, and Watcher's `projection`,
counted field by field, so a field added anywhere in a push is one more part, and one more unchanged part whenever it
repeats. Each push is measured against the last push of the same event. The frame's `v` and `event` count, which is why a desktop's push has 44 unchanged parts where the benchmark
reported 42 before review. A change of progress alone is counted whichever push carries it: a `watcher-state` whose only
moved parts are `progress`, `revision` and `observedAt`, or a `watcher-progress`, which #2391 adds.

The byte budgets have 2% room for a push and 1% for Watcher's, since the host's folders are in a push and a temporary
folder's path is longer on Windows and macOS than on Linux. The counts have none. Every budget only tightens.

It asserts sizes and counts, never times. It steps the clock the way the benchmark does (How the clock waits, above),
so it gives the same numbers on every run:

- **Under load.** Ten rounds of two copies at once, with ten processes spinning on forge's 16 cores (load average 8 to
  19), passed all 20 runs with the numbers above. The guard as it was before review, five rounds the same way (load
  average 6 to 12), passed all 10 but counted 13 to 17 pushes to the desktop and 199,830 to 199,913 bytes a push.
- **With compression held back.** Holding every off-loop compression's answer back 20 ms and then 100 ms gave the same
  numbers. Before review, 100 ms failed the guard at setup, its desktop's client timing out on the fake clock, and 20 ms
  counted 9 pushes rather than 15.

It was checked both ways. Each of these, added to `src/host/socketServer.ts` and taken out again, failed it:

| Added to every push | Measure that failed |
|---|---|
| `probeUnchanged: true` beside `state` in a thread list push | unchanged parts to a desktop, 45 against 44 |
| `probeUnchanged: true` in the state of a thread list push | unchanged parts to a desktop, 45 against 44 |
| `probeUnchanged: true` beside `projection` in a `watcher-state` | unchanged parts per change of progress, 9 against 8 |
| `probeUnchanged: true` in Watcher's projection | unchanged parts per change of progress, 9 against 8 |

Each added 22 bytes to a push, inside the byte budgets: the part counts are what catch a small part that never changes.

The fixes it measures lower a budget rather than fail it. With each merged in for a run and taken out again:

| Measure | Today | With #2405 (`153f6604d`, for #2391) | With #2404 (`893c83b34`, for #2392) |
|---|---:|---:|---:|
| Bytes per change of Watcher's progress alone | 1,986,099 | 451 | 1,986,099 |
| Parts of it as the push before had them | 8 | 2 (the frame's `v` and `event`) | 8 |
| Whole `watcher-state` pushes per change of progress alone | 1 | 0 | 1 |
| Bytes per thread list push to an iPhone | 198,970 | 198,970 | 73,177 |
| Parts of a push to an iPhone as the push before had them | 45 | 45 | 41 |

## What else moved

- `watcherStatePush.perf.test.ts` builds its records with the shared builder: one desktop rather than a new one for every
  request, and operations with Watcher's fields. At 925 requests its push is 1,974,722 bytes, 237,721 compressed, where it
  was 1,720,412 and 161,554; forge's saved record makes 2,086,237 and 374,132.
- The default fixture did not move: `ownerScaleWorkBudget`, `streamingCopyBudget` and `copySites` pass as they were.

## What the fixture guesses

- **Skill lists.** The evidence has their size, not their count: six threads' lists of forty skills with 300-character
  descriptions make it. Each thread's descriptions are its own, which makes a push compress to 48 KB against forge's 60 KB.
  With every thread's the same, it compressed to 31 KB.
- **Watcher's archive.** forge's host kept all 925 of the laptop's requests in its live record. Watcher's archive would keep
  the newest 200 closed ones (`archivableWatcherRequests`), and on this fixture it did, leaving a 385 KB projection. Why
  forge's host did not archive them was not traced, so the host-scale fixture holds its archive back.
- **Requests and operations.** The fixture's requests are 18% larger than forge's and its operations 18% smaller. Together
  they are within 1%.
- **Thread records** are synthetic, about 2 KB to a desktop where forge's laptop was sent about 4 KB.

## Not done here

- The iPhone benchmarks' stream (`apps/ios/Sources/SottoCore/BenchWire.swift`) still sends a thread list push of 2,075
  bytes. Making it the size a host sends is a later pull request, the last item of #2390.
- Times are forge's and were not compared. The benchmark still prints the host process's CPU per stretch.

## Take it again

On forge, with CI's Node:

```sh
PATH=$HOME/.local/share/mise/installs/node/24.22.1/bin:$PATH
SOTTO_PERF_BENCH=1 SOTTO_AUDIT_SOCKET=1 NODE_OPTIONS=--max-old-space-size=3072 \
  npx vitest run tests/perf/dataTransfer.perf.test.ts -t "host socket" --maxWorkers=1 --disable-console-intercept
SOTTO_PUSH_SIZES=1 npx vitest run tests/perf/hostPushSizeBudget.perf.test.ts --disable-console-intercept
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/watcherStatePush.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

Evidence, sizes, counts and field names only: `docs/perf/data/2026-11-10-real-size-transfer-benchmarks/`
(`data-transfer-socket-before.json`, `data-transfer-socket-after.json`, `host-push-sizes.json`,
`host-push-guard-checks.json`, `watcher-state-push-fixture.json`).
