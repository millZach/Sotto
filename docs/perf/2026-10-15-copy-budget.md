# Copy budget — October 15, 2026

Main's update path runs on every streamed chunk, for every thread. In October 2026 it came to spend most of its time
copying state. A live profile of the owner's Owl build, with 232 threads, showed main's JavaScript thread busy 82% of
the time over five and a half minutes, with 1,032 stretches of 100 ms or more without a break, the longest 1.5 seconds.
Deep copies were 47% of main's time. Typing lagged because main could not answer the window.

Three copies were new or had become hot, and none came from a performance change:

- Watcher's observe pass copied the Watcher record about three times per thread on every update (#1038), about 21% of
  main.
- The host-update pill asked which threads keep a host busy by rebuilding every host's shell, twice per waiting host per
  change, about 17% of main while a saved host ran an older Sotto.
- The local host forwarded a fresh full shell to the router for every Watcher publish, which follows every coordinator
  broadcast.

Each looked harmless where it was written, and cost nothing with a few threads. Timing checks are opt-in because they
are flaky, so nothing in CI noticed.

## The guards

Two checks run in every CI run. They count calls; they never time anything.

- `tests/perf/streamingCopyBudget.perf.test.ts` runs the update path as `src/main/index.ts` wires it: an event-sourced
  adapter, the provider switch, the workspace, the coordinator, Watcher on Owl, the local host service, the desktop
  router, the window's publisher and broadcaster, the Watcher room's publisher, and the host-update busy check with one
  saved host on an older Sotto. On Owl, Watcher is open and watching the streaming thread. It streams one reply with
  20 threads and with 200, and counts every `structuredClone`, `cloneHostSnapshot` and `cloneActivitySnapshot` call,
  and which of them copy the whole state. It fails when one update copies more with 200
  threads than with 20, or when an update passes its budget.
- `tests/unit/main/copySites.test.ts` counts every copy call site in `src/main` and `src/host` (`structuredClone(`,
  `.shell()`, `watcherRecord()`, `cloneHostSnapshot(`, `cloneActivitySnapshot(` and JSON round trips) per file, and
  fails when the count differs from `tests/fixtures/copySites.json`. A new copy shows up in review that way.

`tests/e2e/main-freeze.spec.ts` is the timing side, opt-in like the other benchmarks: it measures main's freezes and the
composer's keystroke latency in the built app while threads stream (`docs/perf/2026-10-15-main-freeze.md`).

## Numbers

Per coordinator update while one thread streams, with Watcher open and watching that thread on Owl:

| | Copies, 20 threads | Copies, 200 threads | Whole-state copies |
| --- | ---: | ---: | ---: |
| Owl before the fixes | 95.5 | 635.5 | 7.9 |
| Owl after | 20.5 | 20.5 | 2.9 |
| Stable before | 12.9 | 12.9 | 5.0 |
| Stable after | 8.9 | 8.9 | 2.95 |

Three runs after the fixes gave the same counts to two decimals. The whole-state copies left are the coordinator's shell
for the broadcast and the workspace's activity snapshots; sharing unchanged threads through those layers is #925's.

The budgets are 23.5 copies and 3.5 whole-state copies per update on Owl, and 10.5 and 3.5 on stable. They only
tighten: a change that lowers a count lowers its budget in the same PR, and a change that needs more copies on this path
asks Zach first.

## When a guard goes red

Read the failure: it says what grew, with the measured numbers. Move the copy off the update path, or read the state
without copying it. The copy-site list is different: a new copy that runs only for a command or a read is fine there.
Say why in the PR and rewrite the list:

```powershell
$env:SOTTO_UPDATE_COPY_SITES = '1'; npx vitest run tests/unit/main/copySites.test.ts
```
