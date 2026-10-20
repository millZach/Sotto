# Main freezing while threads stream - October 15, 2026

The owner's Sotto lags badly while typing with threads streaming. A live profile of the running app, with 232
threads in the sidebar and a few of them streaming, found main's JavaScript thread busy about 82% of the time
over 5.5 minutes, with 1,032 stretches of 100 ms or more without going idle (the longest 1.5 s). The cause is
whole-state deep copies on every streamed update: Watcher's observe pass, a host-update busy check, and the
coordinator's shell copy, each paid again and again as the sidebar grows. Fixes are tracked elsewhere; this note
is the benchmark that reproduces the symptom in the built app, so a fix can be measured before and after.

## What it measures

`tests/e2e/main-freeze.spec.ts` launches the built app, creates about 230 threads beyond the fixture's own two
so the sidebar holds about 232, and opens one of them (`Docs`) in a single pane. For three cases - nothing
streaming, one thread streaming, and three threads streaming, each at about 20 chunks a second for about 15
seconds - it measures two things at once:

- Main's event-loop delay during the case, with `perf_hooks.monitorEventLoopDelay` (max, mean and p99 in
  milliseconds) and a 50 ms drift sampler's count of gaps of 100 ms or more.
- Keystroke-to-screen latency in the `Docs` composer: a synthetic 41-character string typed one key at a time,
  with p50, p95 and max milliseconds from each keydown to the next animation frame after the composer's text
  updates.

It prints one `main freeze: {...}` line per case and asserts only that each case collected samples, never a time
budget; a stopwatch budget would be `SOTTO_PERF_ASSERT=1`'s, which this benchmark does not use.

## Reproduce

On an idle machine, after a build, with the window left on screen: Chromium draws a minimized or covered window
about once a second, and the spec fails a case that drew fewer than 5 frames a second rather than report keystrokes
that wait for it (`docs/perf/2026-10-20-main-lag.md`, Keystrokes).

```powershell
$env:SOTTO_PERF_BENCH = '1'; npm run build; npx playwright test tests/e2e/main-freeze.spec.ts
```

```sh
SOTTO_PERF_BENCH=1 npm run build && npx playwright test tests/e2e/main-freeze.spec.ts
```

## Results

Recorded per change, alongside the commit or branch measured.

**October 15, 2026: main before and after the copy fixes (#1065–#1068), every Owl feature on.** Two runs each, in
the order main, fixed, fixed, main, with `SOTTO_OWL_FEATURES` setting all six features to 1:

| Case | Main: longest stall, stalls of 100 ms or more | Fixed: longest stall, stalls of 100 ms or more | Keystrokes, p95, both |
| --- | --- | --- | --- |
| Nothing streaming | 27–31 ms, 0 | 29–31 ms, 0 | 16–19 ms |
| One thread streaming | 155–232 ms, 5–9 | 176–251 ms, 9–11 | 21–32 ms |
| Three threads streaming | 70–271 ms, 1 | 308–340 ms, 3–4 | 21–25 ms |

The two builds are not told apart, and the benchmark does not yet show the owner's lag, for two reasons that the next
change to it should fix:

- The keystroke timer starts in the renderer, at the key's arrival. In Electron, the main process runs on the thread
  that receives the operating system's input and forwards it to the window, so a key that waits behind a long task in
  main has already waited before the timer starts. Main's stalls are the measure of that wait here; a keystroke timer
  that includes it has to start outside the app.
- The 230 padding threads are drafts with no provider session, so the coordinator, the workspace and Watcher never walk
  them, Watcher is not open, and no saved host waits for an update. The copies the fixes remove happen only when those
  are true. `tests/perf/streamingCopyBudget.perf.test.ts` builds that state and does tell the builds apart: 95.5 rising
  to 635.5 copies per update before, 20.5 after.

**October 20, 2026: the owner's history, and a nightly run (#1232).** The second reason is gone. The benchmark now runs on
Owl with every padding thread given a provider session, Watcher's record at the owner's size (5 standing watches, 160
requests, 150 operations), the owner's 256 answer retirements and a paired headless host with 40 threads, built from
`tests/fixtures/ownerScale.ts`. The fixture's provider has no Watcher model, so Watcher cannot be opened from the
window; the record names one padding thread as the current Watcher instead, so its wake-up pass reads the standing
watches on every update, as the owner's does. With `SOTTO_PERF_ASSERT=1`
it fails when main's longest stall or its count of stalls of 100 ms or more passes the spec's limits, and
`.github/workflows/main-freeze.yml` runs it that way every night (`docs/ci.md`, under Main freeze nightly).
`docs/perf/2026-10-20-main-lag.md` has the counting gate that pull requests meet.
