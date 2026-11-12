# Main froze for over a second after every merge (November 12, 2026)

Found while looking into the freezes reported on Owl 0.1.43-owl.20261112.1
(`2026-11-12-watcher-archive-stopped-threads.md`). An outside watch on main asked one of its local servers for a refusal
ten times a second and logged every late answer. Nothing was written to Sotto's data.

## What was seen

Main was blocked for over a second about two minutes after each of the day's last three merges to `main`, each block
ending as Keep main up to date wrote `main-checkout.json`:

| Merge (UTC) | Main blocked | `main-checkout.json` written |
|---|---|---|
| #2517 at 19:45:26 | 1,149 ms at 19:47:30 | not captured |
| #2515 at 19:47:48 | 1,271 ms at 19:49:30 | 19:49:31.99 |
| #2518 at 19:49:52 | 1,614 ms at 19:51:31 | 19:51:33.05 |

The third was predicted before it happened. An earlier block of 553 ms at 18:15:16 ended the same way. No stack was
captured: the link to the code below is from timing and from reading it.

## Why

When Keep main up to date fast-forwards a project's checkout (ADR-0142), every thread working in that folder reads its
Git status again, so its branch stops saying it is behind. Each thread read the folder for itself, with a read that is
never shared, and saved and published the workspace when its status changed. On the laptop 392 threads worked in the
project's folder, 391 of them settled.

## Measurements

`tests/perf/mainCheckoutMoved.perf.test.ts`, on the laptop: a real repository with an origin, the real reader, threads on
the fake provider in the project's folder, the folder one commit behind and then fast-forwarded.

| Threads in the folder | | Git processes | Saves | Main blocked in all | Longest block |
|---|---|---|---|---|---|
| 3 | before | 15 | 3 | 5 ms | 3 ms |
| 12 | before | 57 | 12 | 107 ms | 47 ms |
| 120 | before | 496 | 120 | 1,743 ms | 485 ms |
| 3 | after | 5 | 1 | 11 ms | 3 ms |
| 120 | after | 5 | 1 | 2 ms | 2 ms |

Every thread's branch stops saying it is behind, before and after.

## What changed

The threads of one folder take one read of it, begun after the move, and are saved and published together. A thread
whose lane is busy reads when it is free, as before.

## The guard

The test runs in the normal gate with three threads and with twelve, and fails when the Git processes or the saves grow
with the threads. `SOTTO_PERF_CHECKOUT_THREADS` sets the larger count and prints the timings.

## Not explained here

The two freezes Sotto recorded at 17:47:29 and 17:47:53 UTC came with no merge and no write of `main-checkout.json`.
The freeze just after that morning's update fits the first pass after start, which wrote the file at 17:45:41, but
nothing recorded main at that moment. From the next Owl a freeze of a second or more saves main's stack (ADR-0098).
