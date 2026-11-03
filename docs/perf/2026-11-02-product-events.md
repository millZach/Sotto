# What product events cost

ADR-0179 says sending must never slow Sotto. This is the sender on its own, before any call site on a thread's turn. Forge, Node under Vitest, three runs at a load average near 5, `tests/perf/productEvents.perf.test.ts`:

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/productEvents.perf.test.ts --maxWorkers=1 --disable-console-intercept --silent=false
```

| What | Result |
|---|---|
| `record` with no endpoint, as every build runs today | under 0.01 microseconds per event |
| `record` switched off | under 0.01 microseconds per event |
| `record` switched on, the largest event | 3.5 to 4.9 microseconds per event |
| Longest event loop delay with nothing to send | 1.3 to 1.9 ms |
| Longest event loop delay sending one batch of 20 | none registered: over before the monitor's 1 ms sample |
| Longest event loop delay sending 1,000 events, 50 batches back to back | 1.5 to 1.9 ms, no more than with nothing to send |
| An hour offline at one timer every 30 seconds, with 1,000 events waiting | 29 failed tries, about 1.7 ms of work in all |

The event loop figures use a local HTTP server in the same process, and a `fetch` made first, because main has fetched long before its first batch. A process's first `fetch` alone adds about 10 ms while its HTTP client loads.

An idle Sotto arms no timer for this at all. The sender sends one batch of at most 20 events every 30 seconds, so the 1,000-event row is a harder case than the sender produces.

## On a thread's turn

Added when `thread.started`, `turn.completed` and `feature.used` got their call sites. Forge, three runs on the final code, load average 0.6 to 0.8.

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/productEvents.perf.test.ts --maxWorkers=1 --disable-console-intercept --silent=false -t "tracker|costs a turn"
```

"Before" is main's real update path with no sender at all: the adapter, the provider switch, the workspace, the coordinator and the window's publisher, at 200 threads, one streaming five turns of 100 updates. "After" is the same path with the real sender switched on and recording each turn. The runs take turns on fresh pipelines, six of each per figure, and the first of each is thrown away, so drift falls on both sides. A benchmark fails if the events it expects were not recorded.

| CPU per update, median of each run | Before | After |
|---|---|---|
| Stable | 0.15, 0.15, 0.15 ms | 0.13, 0.15, 0.14 ms |
| Owl | 0.11, 0.10, 0.12 ms | 0.10, 0.12, 0.11 ms |

The two sides differ by less than the same side differs between runs, and in neither direction consistently, so no cost shows at this resolution. That is a bound rather than a saving: this adds work and speeds nothing up.

Six earlier runs of nearly the same code, on a busier forge, moved both sides together, up to 0.32 ms before and 0.28 ms after on stable, with no consistent order between them.

What it adds, measured alone: 9 to 11 nanoseconds per update for a thread with a turn running, about one ten-thousandth of an update. Who started a thread is asked on a later tick as a turn begins and ends, never during an update, and each event costs `record`'s microseconds above. That question can walk Watcher's record once in a run, to build its index, and that walk is the one cost here that grows with history.

`streamingCopyBudget`, `ownerScaleWorkBudget`, `copySites` and `zodSchemaSites` pass with the tracker wired into their pipelines, and no budget was raised. The first version read the coordinator's shown threads and went 21 reads of a thread per update over `ownerScaleWorkBudget`, so it now reads the thread changes the coordinator is already handed, which walks no list.

## With the endpoint built in

Added when the notice, the switch and the endpoint shipped together. That change adds no call on a thread's turn: the window asks one question at start, and a released build now takes the "switched on" and "sending" rows above rather than the "no endpoint" one. Forge, three runs on the final code, load average 1.5 to 3.0, the full command at the top.

| What | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Longest event loop delay with nothing to send | 1.64 ms | 1.21 ms | 1.19 ms |
| Longest event loop delay sending one batch of 20 | 1.19 ms | none registered | none registered |
| Longest event loop delay sending 1,000 events | 1.35 ms | 1.39 ms | 1.65 ms |
| An hour offline, work in all | 1.46 ms | 1.47 ms | 2.05 ms |
| Stable, CPU per update, before and after | 0.19, 0.15 ms | 0.18, 0.16 ms | 0.17, 0.16 ms |
| Owl, CPU per update, before and after | 0.17, 0.14 ms | 0.14, 0.14 ms | 0.13, 0.14 ms |

Before is main's update path with no sender at all, and after has the tracker and a sender switched on. Stable reads lower after in all three runs, by 0.01 to 0.04 ms on a busy forge, with ranges that overlap; this adds work, so that is noise and not a saving. Nothing here shows a cost, and sending holds the event loop no longer than having nothing to send. This is what a thread's performance is held to.
