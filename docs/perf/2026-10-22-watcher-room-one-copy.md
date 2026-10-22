# Watcher's room copied once per publish

Issue #1327. A one-minute recording of main on 0.1.38-owl.20261021.2 (Windows, October 21, 2026) showed each Watcher room publish copying the room's records twice. `WatcherService.state()` copied the current Watcher, its history, requests, standing watches and operations (1.2 s of the minute), and the desktop room copied the whole room again for its publish window (0.5 s).

The first copy guarded against readers that change what they are given, and none does. Every change to the Watcher record replaces it rather than editing it (`AgentControl.watcherRecordView`), so a record the room hands out never changes under its holder. The window and a phone are sent a serialized copy, a phone's page is built anew and parsed, and Watcher's own readers only read. So `state()` now hands out the record's own records. The one it changed, a request that names the phone that started it, is handed out as a new record without it; the record keeps it. The desktop room's capture for its publish window (ADR-0073) is the one copy a publish makes, and with the window off a publish copies nothing. `state()` also runs for every phone on every update and for Watcher's read_state, which now copy nothing.

`tests/perf/watcherRoomCopyBudget.perf.test.ts` deep-freezes the record and then reads the room, publishes it to a desktop room with the window on and off, gets it and builds a phone's page. An edit by any of them would throw. Every one gets the room as main built it when it copied its records: the record's own, without the phone a request came from. It counts one copy per publish, the desktop room's. On the old code the same test fails where it checks the room hands out the record's own records.

## Counts

Counted, not timed, so they run in the default suite. Stable has no Watcher and is unchanged.

| Owl, at the owner's scale (`ownerScaleWorkBudget`) | Copies before | After | Objects copied before | After |
| --- | ---: | ---: | ---: | ---: |
| An update while 1 thread streams | 11 | 10 | 8,099.5 | 6,662.5 |
| An update while 3 threads stream | 14.69 | 13.69 | 9,995.2 | 8,558.2 |
| Save an answer draft | 19 | 17 | 25,906 | 23,032 |
| Type in the composer | 23 | 21 | 27,326 | 24,452 |
| Open a thread | 36 | 34 | 42,446 | 39,572 |
| Send | 141 | 136 | 104,535 | 97,350 |

`streamingCopyBudget` counted 10.4 to 10.7 copies per Owl update before and 9.4 to 9.8 after, and its Owl budget is now 10. A Watcher publish copies the record no times (`watcherPassCost`, from one). The owner-scale budgets drop by the same amounts. The objects Owl copies still grow with the history, through the desktop room's capture and a command's copy of the whole record, by less than they did: 1.40 times from a quarter of the owner's history to all of it while one thread streams, from 1.58.

## Time

Timed once on the shared development PC with other test runs going, so read it as a direction, not a budget. At the owner's scale (250 threads, 160 requests, 144 operations, 5 standing watches), the median of five rounds of 200 calls: `state()` took 3.07 ms before and 1.81 ms after, and a whole publish with the desktop room listening (the observe pass, the room state and the capture) 5.33 ms before and 4.03 ms after.

## Commands

```sh
SOTTO_PERF_BENCH=1 npx vitest run tests/perf/streamingCopyBudget.perf.test.ts tests/perf/ownerScaleWorkBudget.perf.test.ts tests/perf/watcherPassCost.perf.test.ts --maxWorkers=2 --disable-console-intercept
npx vitest run tests/perf/watcherRoomCopyBudget.perf.test.ts tests/unit/main/watcherRoomDesktop.test.ts tests/unit/main/copySites.test.ts --maxWorkers=2
```
