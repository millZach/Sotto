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

## Before and after

One thread streaming, 60 chunks in 3 seconds and one more second, on Owl, long threads. Before is the benchmark as of
`c9a0940fd`, the audit's branch. Bytes are JSON. Compressed is deflate level 6, as the host compresses for a desktop; the
host compresses nothing for a phone. forge's figures are the audit's (`docs/perf/data/2026-11-10-audit/`).

| | Before | Now | forge's host | Now against forge |
|---|---:|---:|---:|---:|
| A thread list push to the desktop | 8,888 (59 pushes after one of 205,905 listing every thread) | 200,032 (23 pushes) | 210,659 (103 in 2 minutes) | 0.95 |
| The same, compressed | not counted apart | 48,323 | 60,270 | 0.80 |
| A thread list push to the phone | 6,827 (after one of 204,308 listing every thread) | 199,134 (6 pushes) | 209,015 (32 in a minute, a working thread open) | 0.95 |
| A `watcher-state` push to the desktop | none sent | 1,986,294 (23 pushes) | 1,976,203 (254 in 2 minutes) | 1.00 |
| The same, compressed | none sent | 297,991 | 365,739 | 0.81 |
| `watcher-state` built from forge's saved record (`watcherStatePush`) | | | 2,086,237, 374,132 compressed | 0.95 |
| Hello to the desktop | 416,811 | 609,390 | not measured | |
| Hello to the phone | 406,374 | 476,592 | 236,631 (154 settled threads held back) | |
| Observing the streaming threads, phone | 854,572 | 87,235 (the step window) | 92,599 for one thread | |

Each push is within a quarter of forge's. What is in one:

| Part of a push | Now, to the desktop | forge, to the phone |
|---|---:|---:|
| `skillCatalogs` | 112,819 | 115,223 |
| `deliveries` | 44,417 | 45,933 |
| `deliveredDrafts` | 12,929 | 12,929 |
| `obsoleteDrafts` | 12,929 | 12,929 |
| `followupReceipts` | 7,980 | 7,980 |
| `host.projects` | 2,764 | 3,346 |
| `host.providers` | 2,263 | 2,760 |
| Changed thread records | 2,132 (1,214 to the phone) | 2,509 (about 4,200 to the laptop) |
| Parts as the push before had them | 42 of 43, 197,217 bytes | about 205 KB of 209 KB |

| Part of a `watcher-state` push | Now | forge |
|---|---:|---:|
| `requests` | 1,177,671 | 995,250 |
| `operations` | 783,097 | 952,735 |
| `progress` | 24,961 (130 threads) | 24,961 (130 threads) |
| Parts as the push before had them | 6 of 9; only `progress`, `revision` and `observedAt` moved | the same |

22 of the 23 `watcher-state` pushes changed only Watcher's progress. The other carried the user's prompt on a thread the
desktop's Watcher had worked on, which the host records against that thread.

## The guard

`tests/perf/hostPushSizeBudget.perf.test.ts` runs in the default suite, in about 3 seconds on forge. It builds the same
host, starts one thread, streams 10 chunks so what goes once after observing is behind it, then counts 40 more:

| Measure | Today | Budget | Lowered by |
|---|---:|---:|---|
| Bytes per thread list push to a desktop | 199,863 | 204,000 | #2393 |
| Bytes per thread list push to an iPhone | 198,970 | 203,000 | #2392, #2393 |
| Parts of a push to a desktop as the push before had them | 42 | 42 | #2393 |
| Parts of a push to an iPhone as the push before had them | 43 | 43 | #2392, #2393 |
| Bytes per `watcher-state` push that changes only progress | 1,986,099 | 2,006,000 | #2391 |
| Parts of a `watcher-state` push as the push before had them | 6 | 6 | #2391 |

The byte budgets have 2% room for a push and 1% for `watcher-state`, since the host's folders are in a push and a
temporary folder's path is longer on Windows and macOS than on Linux. The counts have none. Every budget only tightens.

It was checked both ways. With one part that never changes added to every thread list push (`probeUnchanged: true` in
`shell` in `src/host/socketServer.ts`), it failed: 43 parts against 42. With one added to Watcher's projection, it failed:
7 against 6. Both were taken out.

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
`watcher-state-push-fixture.json`).
