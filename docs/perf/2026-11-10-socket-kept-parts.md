# A socket client is sent the unchanged parts of the shell once - November 10, 2026

The November 10 audit (`2026-11-10-performance-and-data-audit.md`, finding 2) found that a host sends every socket client
its whole state in every shell push but for two parts: the thread records, sent as changed thread records, and the model
catalog, sent by its revision. On forge's host a push was about 200 KB of JSON to the laptop, 60 KB compressed, and 209 KB
to a phone, where the news was a few kilobytes of changed thread records. #2392 left out of a phone's shell the five parts
no phone reads, which brought a phone's push to about 73 KB. This is the second step (#2393), which finishes #996: a host
sends a client that accepts `kept-parts` each part once, and then only when it changes.

## What changed

The window has had **kept parts** since October 30 (`withKeptParts` in `src/main/agents/agentStateBroadcast.ts`, ADR-0028).
A socket client now gets the same, from the same code:

- **The host** (`src/host/socketServer.ts`) lists `kept-parts` on every listener. To a client whose hello accepts it beside
  `changed-thread-records`, a shell push whose thread records are measured from the last push written to that connection
  leaves out each part that holds what that push held, and names it in `kept` and `host.kept`. The host's `threads`,
  `models`, `modelsRevision` and `providerModeLists` always go as made. The host holds each written push's parts by
  reference on the connection's own record, under the push's thread records' revision.
- **Only pushes count.** Hello, a `shell` read and a command's answer carry every part, as before, and move nothing. The
  first push after a hello or a `shell` read carries every part, and the push after it keeps what it can.
- **The repeat check and Watcher's writing window** read the whole state, as before. A push is cut down only once it is
  going, after both checks, and one held back or not sent moves nothing.
- **The desktop's client of a paired host** (`src/main/agents/socketHostService.ts`) accepts the feature and puts the parts
  back from the push it applied last before it reads the catalog or checks the shell against its schema. The window's page
  and the desktop's client share that code, now in `src/shared/keptParts.ts`. A push it cannot put back has it read the
  shell whole with `shell`, after which the host's next push keeps nothing.
- **The iPhone** (`KeptPartsCache` in `apps/ios/Sources/SottoCore/KeptParts.swift`) accepts it, reads which parts a push kept
  and carried beside its state, puts each back from the push it applied last in `HostConnection`, and drops the connection
  and connects again when it cannot.
- **The Android client** is left alone and is sent every part, as is any client that does not accept the feature.

Nothing a provider or model receives changed, and nothing a client shows: the window was broadcast the same bytes as
before (below).

## The measure

The data-transfer benchmark's host-socket test builds a host the size of forge's and connects Sotto's own client of a
paired host, a desktop that accepts what that client accepts, and a phone that sends the iPhone's own list read from the
Swift source (`docs/perf/2026-11-10-real-size-transfer-benchmarks.md`). Before is `bad5165fa`, `main` with #2404 and #2405
merged in, the base of this change. Each was run three times on forge with CI's Node, one after the other. Bytes are JSON;
compressed is deflate level 6, as the host compresses for a desktop. The sizes and counts are the same on every run.

| One host thread streaming, 60 pushes | Before | After |
| --- | ---: | ---: |
| A thread list push to the desktop | 200,099 bytes | 2,922 bytes |
| The same, compressed | 48,290 to 48,343 | 1,127 to 1,128 |
| A thread list push to the phone | 73,305 bytes | 1,882 bytes |
| Parts of a push to the desktop as the push before had them | 44 | 7 |
| Parts of a push to the phone as the push before had them | 41 | 7 |
| Bytes broadcast to the desktop's window | 167,932 | 167,932 |
| The process's CPU for the stretch | 1,929 to 2,471 ms | 1,409 to 1,565 ms |

| Three host threads streaming, 61 pushes | Before | After |
| --- | ---: | ---: |
| A thread list push to the desktop | 204,323 bytes | 7,146 bytes |
| The same, compressed | 48,456 to 48,511 | 1,273 to 1,275 |
| A thread list push to the phone | 75,664 bytes | 4,241 bytes |
| Bytes broadcast to the desktop's window | 431,535 | 431,535 |
| The process's CPU for the stretch | 1,879 to 2,560 ms | 1,426 to 1,548 ms |

A push that changes one thread is under the 10 KB #2393 asks for, to a desktop and to a phone. What is left in one is
the changed thread record, 2,199 bytes to the desktop and 1,214 to the phone, and the names of the parts kept, 551 and
496 bytes.
The seven parts that repeat are the frame's `v` and `event`, `state.kept`, `state.host.kept`, the host's empty `threads`
and catalog revision, and the event page. A hello is 13 bytes longer, for the feature's name.

The window was broadcast the same bytes before and after, so the desktop's client put back the state it was sent whole
before. The CPU is the benchmark's whole process, the host, its three clients, the router and the window together, on a
shared machine, so only its direction is worth reading: the host walks each part it compares, which it did not before, but
compresses and the desktop's client reads a fortieth of what they did.

## The guard

`tests/perf/hostPushSizeBudget.perf.test.ts` (since #2406) builds the same host, now with both clients accepting
`kept-parts`, and counts 40 pushes to the desktop and 4 to the phone while one thread streams:

| Measure | Before | After | Budget |
| --- | ---: | ---: | ---: |
| Bytes per thread list push to a desktop | 199,919 | 2,850 | 3,100 (was 204,000) |
| Bytes per thread list push to an iPhone | 73,177 | 1,826 | 2,100 (was 203,000) |
| Parts of a push to a desktop as the push before had them | 44 | 7 | 7 (was 44) |
| Parts of a push to an iPhone as the push before had them | 41 | 7 | 7 (was 45) |

The byte budgets have about 250 bytes of room: the changed record names the host's folder twice, and a temporary folder's
path is longer on Windows and macOS than on Linux. The counts have none. A part added to every push that never changes is
kept, so it costs its name, not its bytes.

## The tests

- `tests/integration/socketKeptParts.test.ts`: over a real listener, a client that accepts the feature is sent only the
  parts that changed and puts back the very state a client without it is sent; the push after a `shell` read keeps
  nothing; a repeat is still not sent; hello, a `shell` read and a command's answer carry every part; a client without the
  feature, or with it but without changed thread records, is sent every part. The desktop's own client shows the whole
  shell from pushes that keep parts, and a push naming a part it does not hold, or measured from a push it did not apply,
  has it read the shell whole and show nothing of that push.
- `tests/unit/shared/keptParts.test.ts`: putting parts back, and refusing parts measured from another shell or naming one
  that shell did not have.
- `apps/ios/Tests/SottoCoreTests/KeptPartsTests.swift`: the iPhone reads what a push kept, puts the parts back from the push
  before, and refuses a push it cannot put back without moving what it holds.

## On forge's host

The issue asks for the measure with `host-wire-tally.py` and `phone-wire-probe.mjs` on forge's running host. That needs a
host with this change running there, and an iPhone build with it for the phone's side, so it waits for the next Owl. From
the audit's push of about 210 KB to the laptop and the benchmark's within a quarter of it, a push that changes one thread
should be about 3 KB to the laptop and 2 KB to an iPhone.

## Take it again

On forge, with CI's Node:

```sh
PATH=$HOME/.local/share/mise/installs/node/24.22.1/bin:$PATH
SOTTO_PERF_BENCH=1 SOTTO_AUDIT_SOCKET=1 NODE_OPTIONS=--max-old-space-size=3072 \
  npx vitest run tests/perf/dataTransfer.perf.test.ts -t "host socket" --maxWorkers=1 --disable-console-intercept
SOTTO_PUSH_SIZES=1 npx vitest run tests/perf/hostPushSizeBudget.perf.test.ts --disable-console-intercept
```

Evidence, sizes, counts and field names only: `docs/perf/data/2026-11-10-socket-kept-parts/`
(`data-transfer-socket-before.json`, `data-transfer-socket-after.json`, `host-push-sizes.json`).
