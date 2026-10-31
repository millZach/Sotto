# What a window broadcast keeps - October 30, 2026

Two benchmarks, three runs each on forge, main's code and this change.

- The data-transfer benchmark's main-process block (`tests/perf/dataTransfer.perf.test.ts`,
  `docs/perf/2026-10-29-data-transfer.md`): the owner-scale pipeline on Owl. Its `window state` channel counts each
  broadcast as Electron's structured clone would serialize it.
- `tests/perf/windowChangedThreads.perf.test.ts`: main as `src/main/index.ts` wires it, 291 threads on Owl and 290 on
  stable, three streaming. Every state the router publishes goes through main's broadcaster, is serialized, and is read
  back by the page's own `wrapAgentBridge` and state sharing. It reports the median bytes of a streaming broadcast and
  each side's time per broadcast, and checks every state the page rebuilds against the state main published.

```sh
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/dataTransfer.perf.test.ts -t "measures what main moves" --maxWorkers=1 --disable-console-intercept
SOTTO_PERF_BENCH=1 NODE_OPTIONS=--max-old-space-size=3072 npx vitest run tests/perf/windowChangedThreads.perf.test.ts --maxWorkers=1 --disable-console-intercept
```

## What it cost

Since #1330 a broadcast carries only the thread records that changed, but every other part of the shell crossed whole on
every broadcast. That covered the drafts, the receipt lists, the deliveries, the projects, the providers, the paired hosts
and the settings. On the benchmark's state that was about 12 KB of a 14.6 KB broadcast, sent up to seventeen times a second
while a reply streams. The page walked it all again each time in state sharing, every part a fresh object.

## The change

A broadcast leaves out each part that holds what the broadcast its threads are measured from held, and names it in
`kept`. The page puts each back from the broadcast it applied, so the part is the object it already held (ADR-0028,
October 30 kept parts amendment).

## Before and after

| Per broadcast, data-transfer benchmark (Owl) | Before | After |
| --- | ---: | ---: |
| One thread streaming | 14,580 bytes | 2,680 bytes |
| Three threads streaming | 18,818 bytes | 6,918 bytes |
| A draft save | 12,600 bytes | 1,452 bytes |

Every run sent the same bytes.

| Per streaming broadcast, `windowChangedThreads` | Before | After |
| --- | ---: | ---: |
| Bytes, Owl | 13,624-13,635 | 4,358-4,410 |
| Bytes, stable | 12,574 | 4,466 |
| The page's work, Owl | 0.212-0.216 ms | 0.126-0.127 ms |
| The page's work, stable | 0.189-0.194 ms | 0.128-0.136 ms |
| Main's work, Owl | 0.076-0.079 ms | 0.062-0.065 ms |
| Main's work, stable | 0.120-0.129 ms | 0.113-0.118 ms |

Main compares each part with the one it last sent, identity first, which costs less than encoding the part again. These
states have empty receipt lists. Full lists on the owner's computer are about 41 KB more on every broadcast, now kept
while they do not change.

## The guards

- `tests/unit/renderer/agentStateThreads.test.ts`, main's broadcaster and the page's own wrapper over structured-cloned
  payloads:
  - a broadcast leaves out each part that did not change and names it, and the page delivers the state main broadcast,
    each kept part the very object it delivered before;
  - a part that changed crosses whole;
  - after the window reads the whole state a broadcast keeps nothing;
  - one measured from a broadcast the page did not apply is read whole.
  - Its long seeded run of changes, lost messages, failed sends and reads stays equal to main with kept parts.
- `tests/perf/windowChangedThreads.perf.test.ts`, in the default suite: every state the page rebuilds is the state main
  published, on Owl and stable.

## What it leaves

A command's reply to the window still carries every part. It could keep them the same way, measured from the
broadcast its threads are measured from (ADR-0028, October 30 command replies).
